/**
 * FlowMine — Aurora PostgreSQL client.
 *
 * Wraps the `pg` driver in a process-wide connection pool and a small typed
 * query helper so every API route, the pattern-detection Lambda, and the
 * skill executor speak to Aurora through the same interface.
 *
 * Aurora Serverless v2 sits behind an RDS proxy/TLS endpoint, so we always
 * connect with SSL enabled. In production we trust the AWS-managed CA bundle
 * baked into the runtime; locally we still negotiate TLS but don't require
 * the certificate to chain to a known root (developer workstations rarely
 * have the rds-ca-rsa2048-g1 root installed).
 */

import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const HOST = process.env.AURORA_HOST;
const PORT = Number(process.env.AURORA_PORT ?? 5432);
const DATABASE = process.env.AURORA_DATABASE ?? 'flowmine';
const USERNAME = process.env.AURORA_USERNAME;
const PASSWORD = process.env.AURORA_PASSWORD;

/**
 * Max sockets per Next.js function instance. Vercel runs many concurrent
 * serverless instances; keeping the per-instance pool small avoids exhausting
 * Aurora's `max_connections` quota during traffic spikes.
 */
const POOL_MAX = 5;

/** Drop idle sockets after 30 s so cold-start cost dominates instead of
 *  keeping a half-dead pool alive across deployments. */
const POOL_IDLE_MS = 30_000;

/**
 * Refuse to start a query that has been waiting for a free connection longer
 * than 5 s — better to surface a clear timeout to the caller than to silently
 * stretch tail latency on the dashboard.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

// -----------------------------------------------------------------------------
// Pool singleton
// -----------------------------------------------------------------------------

declare global {
  var __flowmineAuroraPool: Pool | undefined;
}

function buildPoolConfig(): PoolConfig {
  if (!HOST || !USERNAME || !PASSWORD) {
    throw new Error(
      'Aurora env vars missing: set AURORA_HOST, AURORA_USERNAME, ' +
        'AURORA_PASSWORD in web/.env.local before querying.',
    );
  }

  return {
    host: HOST,
    port: PORT,
    database: DATABASE,
    user: USERNAME,
    password: PASSWORD,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // Aurora always wants TLS. `rejectUnauthorized: false` lets the
    // developer machine connect without installing the RDS CA bundle;
    // production runtimes (Vercel / Lambda) already ship with the AWS
    // root certs, so we keep the same setting for simplicity.
    ssl: { rejectUnauthorized: false },
  };
}

/**
 * Lazy pool accessor. We don't construct the pool at module load because that
 * would force a TLS handshake during build (when env vars are unavailable on
 * preview deployments) and would crash any route that imports this file purely
 * for the typed `query` helper.
 */
function getPool(): Pool {
  if (!globalThis.__flowmineAuroraPool) {
    globalThis.__flowmineAuroraPool = new Pool(buildPoolConfig());

    // pg's default behaviour is to crash the process on an idle-pool error;
    // log instead so a flaky Aurora endpoint doesn't take down a serverless
    // function instance handling unrelated requests.
    globalThis.__flowmineAuroraPool.on('error', (err) => {
      console.error('[aurora] idle client error:', err);
    });
  }
  return globalThis.__flowmineAuroraPool;
}

// -----------------------------------------------------------------------------
// Typed query helper
// -----------------------------------------------------------------------------

/**
 * Run a parameterised SQL query and return the typed rows. Generic `T` is the
 * shape of a single row; callers should pass a type from `@/lib/types`
 * (Pattern, Skill, ...) so the result is fully typed at the call site.
 *
 * Always use `$1`, `$2`, ... placeholders — never string interpolation — to
 * keep the parameterised-query SQL injection guarantee intact.
 */
export async function query<T extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  const pool = getPool();
  // `pg` expects a mutable array; we accept ReadonlyArray at the API
  // boundary so callers can pass `as const` tuples without a cast, and copy
  // once here before handing the array to the driver.
  return pool.query<T>(sql, [...params]);
}

/**
 * Run a function inside a single transaction. Commits on success, rolls back
 * on any thrown error, and always releases the underlying client back to the
 * pool. Use this for multi-statement workflows like "insert pattern + insert
 * pattern_users rows" that must be all-or-nothing.
 */
export async function transaction<T>(
  fn: (queryFn: typeof query) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txQuery: typeof query = async <R extends QueryResultRow>(
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ) => client.query<R>(sql, [...params]);
    const result = await fn(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------------
// Lifecycle helpers
// -----------------------------------------------------------------------------

/**
 * Shut the pool down cleanly. Used by long-running scripts (the seed-events
 * generator, one-off migrations) so the Node process can exit; never called
 * from request handlers.
 */
export async function closePool(): Promise<void> {
  if (globalThis.__flowmineAuroraPool) {
    await globalThis.__flowmineAuroraPool.end();
    globalThis.__flowmineAuroraPool = undefined;
  }
}

export { getPool as getAuroraPool };
