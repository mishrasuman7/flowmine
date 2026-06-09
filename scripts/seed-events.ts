/**
 * FlowMine — seed-events.ts
 *
 * Generates a deterministic 3-week stream of synthetic browser events for the
 * 5 demo users defined in scripts/schema.sql. Three workflow patterns are
 * deliberately planted so the pattern-detection Lambda has clear, scoreable
 * sequences to find (see Section 12 of the project spec):
 *
 *   Pattern A — salesforce.com -> docs.google.com -> mail.google.com
 *               5 users, every weekday around 09:00 local.
 *   Pattern B — github.com -> linear.app -> slack.com
 *               3 users, every weekday around 14:00.
 *   Pattern C — hubspot.com -> docs.google.com -> mail.google.com
 *               4 users, every Monday around 10:30.
 *
 * Around every pattern occurrence we sprinkle ~30% noise events (random
 * domains from a small grab-bag) so detection has to discriminate signal
 * from noise, not just memorise the data.
 *
 * Two run modes:
 *   pnpm seed:dry    — write the generated events to ./out/seed-events.json
 *                      so you can inspect them or feed them into the
 *                      detection Lambda offline. No AWS credentials needed.
 *   pnpm seed:apply  — write directly to the DynamoDB flowmine-events table
 *                      using AWS credentials read from ../web/.env.local.
 *                      Uses BatchWriteItem chunked at 25 per request.
 *
 * The generator uses a seeded PRNG, so re-running it produces byte-identical
 * output. This matters for the dashboard demo: you want the same set of
 * patterns to surface every time you reset.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { config as loadDotenv } from 'dotenv';

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const MODE: 'dry' | 'apply' = args.has('--apply') ? 'apply' : 'dry';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env from web/.env.local so the script and the API agree on table name
// and region. Falls back silently if the file is absent (dry mode does not
// need AWS credentials at all).
loadDotenv({ path: path.join(__dirname, '..', 'web', '.env.local') });

const TEAM_ID = 'demo_team_001';
const USERS = [
  'demo_user_001',
  'demo_user_002',
  'demo_user_003',
  'demo_user_004',
  'demo_user_005',
] as const;

const TABLE_NAME = process.env.DYNAMODB_EVENTS_TABLE ?? 'flowmine-events';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

const DAYS = 21; // 3 weeks
const TTL_SECONDS = 90 * 24 * 60 * 60;

// -----------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// -----------------------------------------------------------------------------

/**
 * mulberry32: a tiny seeded PRNG with good distribution for small datasets.
 * We use it everywhere a random choice is needed so the entire seed output
 * is reproducible from a fixed seed.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seed chosen once so re-runs are byte-identical. Any 32-bit integer works.
const rng = makeRng(0xf10c01ce);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function jitterMs(plusMinus: number): number {
  return Math.floor((rng() - 0.5) * 2 * plusMinus);
}

// -----------------------------------------------------------------------------
// Event shape
// -----------------------------------------------------------------------------

type BrowserEventType = 'navigate' | 'tab_activate' | 'tab_close';

interface SeedEvent {
  team_id: string;
  event_key: string;
  user_id: string;
  domain: string;
  event_type: BrowserEventType;
  tab_id: string;
  session_id: string;
  timestamp: number;
  created_at: number;
}

let seqCounter = 0;

function makeEvent(
  user: string,
  domain: string,
  timestamp: number,
  session: string,
  type: BrowserEventType = 'navigate',
): SeedEvent {
  const seq = seqCounter++;
  return {
    team_id: TEAM_ID,
    event_key: `${timestamp}#${user}#${seq}`,
    user_id: user,
    domain,
    event_type: type,
    tab_id: `tab_${(seq % 16) + 1}`,
    session_id: session,
    timestamp,
    // Mirror the API-side TTL contract: 90-day retention measured from
    // capture time, not write time.
    created_at: Math.floor(timestamp / 1000) + TTL_SECONDS,
  };
}

function makeSessionId(): string {
  // 9-char base36 chunk is plenty of entropy for a synthetic dataset.
  return Array.from({ length: 9 }, () =>
    Math.floor(rng() * 36).toString(36),
  ).join('');
}

// -----------------------------------------------------------------------------
// Planted workflow patterns
// -----------------------------------------------------------------------------

interface PlantedPattern {
  name: string;
  sequence: readonly string[];
  /** Indexes into USERS that participate in this pattern. */
  userIndexes: readonly number[];
  /** 0 = Sunday, 1 = Monday, ... 6 = Saturday. */
  weekdays: readonly number[];
  /** Local hour the pattern usually starts at (24h). */
  hour: number;
  /** Local minute the pattern usually starts at. */
  minute: number;
}

const PATTERN_A: PlantedPattern = {
  name: 'Salesforce -> Sheets -> Gmail',
  sequence: ['salesforce.com', 'docs.google.com', 'mail.google.com'],
  userIndexes: [0, 1, 2, 3, 4],
  weekdays: [1, 2, 3, 4, 5], // Mon-Fri
  hour: 9,
  minute: 5,
};

const PATTERN_B: PlantedPattern = {
  name: 'GitHub -> Linear -> Slack',
  sequence: ['github.com', 'linear.app', 'slack.com'],
  userIndexes: [0, 1, 2],
  weekdays: [1, 2, 3, 4, 5],
  hour: 14,
  minute: 0,
};

const PATTERN_C: PlantedPattern = {
  name: 'HubSpot -> Docs -> Gmail',
  sequence: ['hubspot.com', 'docs.google.com', 'mail.google.com'],
  userIndexes: [0, 1, 3, 4],
  weekdays: [1], // Mondays only
  hour: 10,
  minute: 30,
};

const PATTERNS = [PATTERN_A, PATTERN_B, PATTERN_C] as const;

// -----------------------------------------------------------------------------
// Noise grab-bag
// -----------------------------------------------------------------------------

const NOISE_DOMAINS = [
  'youtube.com',
  'twitter.com',
  'news.ycombinator.com',
  'stackoverflow.com',
  'notion.so',
  'amazon.com',
  'reddit.com',
  'wikipedia.org',
  'medium.com',
  'figma.com',
] as const;

// -----------------------------------------------------------------------------
// Generation
// -----------------------------------------------------------------------------

const START_DATE = new Date();
// Anchor 3 weeks back from now, rounded down to midnight, so the seeded data
// always lands in the operator's recent past.
START_DATE.setUTCHours(0, 0, 0, 0);
START_DATE.setUTCDate(START_DATE.getUTCDate() - DAYS);

function dayTimestamp(dayIndex: number, hour: number, minute: number): number {
  const date = new Date(START_DATE);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
}

function weekdayOf(dayIndex: number): number {
  const date = new Date(START_DATE);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.getUTCDay();
}

function emitPatternOccurrence(
  pattern: PlantedPattern,
  user: string,
  startMs: number,
  out: SeedEvent[],
): void {
  const session = makeSessionId();
  let cursor = startMs;
  for (const domain of pattern.sequence) {
    // 20-90 seconds between steps so the pattern stays inside one session
    // window even with the jitter we add per-step.
    cursor += 20_000 + Math.floor(rng() * 70_000);
    out.push(makeEvent(user, domain, cursor + jitterMs(2_000), session));
  }
}

function emitNoise(user: string, dayIndex: number, out: SeedEvent[]): void {
  // Roughly 30% of total events should be noise; we approximate by emitting
  // ~6 noise events per user-day, since each pattern occurrence is ~3 events.
  const noiseCount = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < noiseCount; i += 1) {
    const hour = 8 + Math.floor(rng() * 11); // 08:00 - 18:59
    const minute = Math.floor(rng() * 60);
    const session = makeSessionId();
    const timestamp = dayTimestamp(dayIndex, hour, minute) + jitterMs(60_000);
    out.push(makeEvent(user, pick(NOISE_DOMAINS), timestamp, session));
  }
}

function generate(): SeedEvent[] {
  const events: SeedEvent[] = [];

  for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
    const weekday = weekdayOf(dayIndex);

    for (const pattern of PATTERNS) {
      if (!pattern.weekdays.includes(weekday)) continue;
      for (const userIdx of pattern.userIndexes) {
        const user = USERS[userIdx];
        if (!user) continue;
        // Skip occasionally so detection has imperfect signal to work with.
        if (rng() < 0.08) continue;
        const start =
          dayTimestamp(dayIndex, pattern.hour, pattern.minute) +
          jitterMs(15 * 60_000);
        emitPatternOccurrence(pattern, user, start, events);
      }
    }

    for (const user of USERS) {
      emitNoise(user, dayIndex, events);
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  // Re-mint event_key after the sort so the seq segment is monotonic in
  // chronological order, matching what the live API route would produce.
  events.forEach((event, idx) => {
    event.event_key = `${event.timestamp}#${event.user_id}#${idx}`;
  });

  return events;
}

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------

async function writeDry(events: SeedEvent[]): Promise<string> {
  const outDir = path.join(__dirname, 'out');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'seed-events.json');
  await writeFile(outPath, JSON.stringify(events, null, 2), 'utf8');
  return outPath;
}

function buildClient(): DynamoDBDocumentClient {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const cfg: DynamoDBClientConfig = { region: REGION };
  if (accessKeyId && secretAccessKey) {
    cfg.credentials = { accessKeyId, secretAccessKey };
  }
  return DynamoDBDocumentClient.from(new DynamoDBClient(cfg), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

async function writeApply(events: SeedEvent[]): Promise<number> {
  const client = buildClient();
  const BATCH = 25;
  let written = 0;

  for (let i = 0; i < events.length; i += BATCH) {
    const chunk = events.slice(i, i + BATCH);
    let pending = chunk.map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;

    while (pending.length > 0) {
      const resp = await client.send(
        new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending } }),
      );
      const unprocessed = resp.UnprocessedItems?.[TABLE_NAME] ?? [];
      written += pending.length - unprocessed.length;
      if (unprocessed.length === 0) break;

      attempt += 1;
      if (attempt >= 3) {
        throw new Error(
          `seed-events: ${unprocessed.length} items unprocessed after ` +
            `${attempt} attempts (table=${TABLE_NAME})`,
        );
      }
      pending = unprocessed.flatMap((req) =>
        req.PutRequest?.Item
          ? [{ PutRequest: { Item: req.PutRequest.Item as SeedEvent } }]
          : [],
      );
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }

    // Light progress signal so a long apply does not look frozen.
    if ((i / BATCH) % 10 === 0) {
      process.stdout.write(
        `[seed-events] ${written}/${events.length} written...\r`,
      );
    }
  }
  process.stdout.write('\n');
  return written;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `[seed-events] mode=${MODE} team=${TEAM_ID} users=${USERS.length} ` +
      `days=${DAYS}`,
  );

  const events = generate();
  const byUser = new Map<string, number>();
  for (const event of events) {
    byUser.set(event.user_id, (byUser.get(event.user_id) ?? 0) + 1);
  }

  console.log(`[seed-events] generated ${events.length} events`);
  for (const [user, count] of byUser) {
    console.log(`[seed-events]   ${user}: ${count} events`);
  }

  if (MODE === 'dry') {
    const outPath = await writeDry(events);
    console.log(`[seed-events] wrote ${outPath}`);
    return;
  }

  console.log(
    `[seed-events] applying to DynamoDB table=${TABLE_NAME} region=${REGION}`,
  );
  const written = await writeApply(events);
  console.log(`[seed-events] success: ${written} events written`);
}

main().catch((err) => {
  console.error('[seed-events] failed:', err);
  process.exit(1);
});
