/**
 * FlowMine — scripts/reset-patterns.mjs
 *
 * Clears all detected patterns, generated skills, attribution rows, and
 * execution logs for a clean re-detection run. Reads Aurora connection
 * details from web/.env.local (same loader approach as run-schema.mjs).
 *
 * Why this exists: the first detection run persisted patterns with
 * est_hours_monthly = null because Gemini interpretation was failing at the
 * time (token-budget truncation, fixed in lib/llm.ts). Re-running detection
 * only fills hours for NEW patterns — existing ones are skipped by the dedup
 * guard. Wiping the tables lets a fresh /api/detect repopulate everything,
 * now with working interpretation.
 *
 * TRUNCATE ... CASCADE order is handled by Postgres via the foreign keys;
 * naming all four tables explicitly keeps the intent obvious.
 *
 * Usage:
 *   cd D:\flowmine\scripts
 *   node reset-patterns.mjs
 *
 * Does NOT touch teams or users — only the detection/skill output.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', 'web', '.env.local');

function loadEnv(file) {
  if (!existsSync(file)) {
    console.error(`[reset-patterns] ${file} not found. Create web/.env.local first.`);
    process.exit(1);
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(ENV_PATH);

const HOST = process.env.AURORA_HOST;
const PORT = Number(process.env.AURORA_PORT ?? 5432);
const USER = process.env.AURORA_USERNAME;
const PASSWORD = process.env.AURORA_PASSWORD;
const DATABASE = process.env.AURORA_DATABASE ?? 'flowmine';

if (!HOST || !USER || !PASSWORD) {
  console.error(
    '[reset-patterns] AURORA_HOST / AURORA_USERNAME / AURORA_PASSWORD missing.',
  );
  process.exit(1);
}

async function main() {
  const client = new pg.Client({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user: USER,
    password: PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`[reset-patterns] connected to ${DATABASE}`);
  try {
    await client.query(
      'TRUNCATE skill_executions, pattern_users, skills, patterns CASCADE',
    );
    console.log('[reset-patterns] cleared patterns, skills, attribution, executions');
  } finally {
    await client.end();
  }
  console.log('[reset-patterns] done — re-run POST /api/detect to repopulate');
}

main().catch((err) => {
  console.error('[reset-patterns] failed:', err.message);
  process.exit(1);
});
