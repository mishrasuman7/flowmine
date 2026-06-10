/**
 * FlowMine — scripts/run-schema.mjs
 *
 * One-off schema runner for environments where psql is not installed.
 * Reads connection details from web/.env.local and executes scripts/schema.sql
 * via the same `pg` driver the runtime uses.
 *
 * The vanilla `psql -f schema.sql` workflow handles two contexts in one pass:
 * it can issue `CREATE DATABASE flowmine` while connected to `postgres`, then
 * use the `\c flowmine` meta-command to switch and continue in the new DB.
 * `pg` clients cannot follow meta-commands, so this script reproduces the
 * same two-phase behaviour explicitly:
 *
 *   1. Connect to the `postgres` database, run every statement up to `\c`.
 *   2. Disconnect, reconnect to `flowmine`, run the remainder.
 *
 * Re-runs are safe — CREATE DATABASE on an existing database errors with
 * code 42P04 which we catch and treat as "already exists, continue".
 *
 * Usage:
 *   cd D:\flowmine\scripts
 *   node run-schema.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const ENV_PATH = path.join(__dirname, '..', 'web', '.env.local');

// -----------------------------------------------------------------------------
// Tiny .env parser — we cannot require dotenv since scripts/ may not have it
// installed; one regex pass over the file is enough for the few keys we read.
// -----------------------------------------------------------------------------
function loadEnv(file) {
  if (!existsSync(file)) {
    console.error(`[run-schema] ${file} not found. Create web/.env.local first.`);
    process.exit(1);
  }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv(ENV_PATH);

const HOST = process.env.AURORA_HOST;
const PORT = Number(process.env.AURORA_PORT ?? 5432);
const USER = process.env.AURORA_USERNAME;
const PASSWORD = process.env.AURORA_PASSWORD;

if (!HOST || !USER || !PASSWORD) {
  console.error(
    '[run-schema] AURORA_HOST / AURORA_USERNAME / AURORA_PASSWORD missing.\n' +
      'Set them in web/.env.local and retry.',
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Read and split schema.sql at the \c boundary
// -----------------------------------------------------------------------------
const raw = readFileSync(SCHEMA_PATH, 'utf8');
const lines = raw.split(/\r?\n/);
const boundaryIdx = lines.findIndex((line) => /^\s*\\c\s+flowmine/i.test(line));
if (boundaryIdx === -1) {
  console.error('[run-schema] Could not find `\\c flowmine` marker in schema.sql');
  process.exit(1);
}

const phase1Sql = lines.slice(0, boundaryIdx).join('\n');
const phase2Sql = lines.slice(boundaryIdx + 1).join('\n');

// -----------------------------------------------------------------------------
// Phase 1: connect to `postgres` and create the `flowmine` database.
// -----------------------------------------------------------------------------
async function runPhase1() {
  const client = new pg.Client({
    host: HOST,
    port: PORT,
    database: 'postgres',
    user: USER,
    password: PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('[run-schema] phase 1: connected to postgres');
  try {
    await client.query(phase1Sql);
    console.log('[run-schema] phase 1: CREATE DATABASE succeeded');
  } catch (err) {
    if (err.code === '42P04') {
      console.log('[run-schema] phase 1: database flowmine already exists, continuing');
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }
}

// -----------------------------------------------------------------------------
// Phase 2: connect to `flowmine` and run the rest.
// -----------------------------------------------------------------------------
async function runPhase2() {
  const client = new pg.Client({
    host: HOST,
    port: PORT,
    database: 'flowmine',
    user: USER,
    password: PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('[run-schema] phase 2: connected to flowmine');
  try {
    await client.query(phase2Sql);
    console.log('[run-schema] phase 2: schema applied');
  } finally {
    await client.end();
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------
async function main() {
  console.log(`[run-schema] host=${HOST} user=${USER}`);
  await runPhase1();
  await runPhase2();
  console.log('[run-schema] done — schema applied successfully');
}

main().catch((err) => {
  console.error('[run-schema] failed:', err.message);
  process.exit(1);
});
