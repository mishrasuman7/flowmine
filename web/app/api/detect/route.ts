/**
 * FlowMine — POST /api/detect
 *
 * Drives the full pattern-detection cycle: scan the recent DynamoDB event
 * window for a team, run the pure algorithm in lib/detect, persist newly
 * discovered patterns to Aurora (along with their per-user attribution
 * rows), interpret each one with Claude Haiku for a description + ROI
 * estimate, and push a Pusher new-pattern event so the live dashboard
 * surfaces the card immediately.
 *
 * This route stands in for the DynamoDB Streams Lambda described in the
 * project spec: same algorithm, same persistence, just HTTP-triggered.
 * Replacing the trigger with a real Lambda + EventBridge schedule later
 * does not require touching detect.ts — the algorithm module is shared.
 *
 * Contract:
 *   POST body: { team_id: string, window_days?: number }
 *   Response 200: { detected: number, persisted: number, skipped: number,
 *                   patterns: PatternWithUsers[] }
 *   Response 4xx: { error }
 *   Response 5xx: { error }
 */

import { randomUUID } from 'node:crypto';

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { NextResponse } from 'next/server';

import { query, transaction } from '@/lib/aurora';
import { interpretPattern } from '@/lib/claude';
import {
  detectPatterns,
  type PatternCandidate,
} from '@/lib/detect';
import { EVENTS_TABLE_NAME, getDynamoClient } from '@/lib/dynamodb';
import { triggerTeamEvent } from '@/lib/pusher';
import type {
  BrowserEvent,
  Pattern,
  PatternStatus,
  PatternWithUsers,
} from '@/lib/types';

export const runtime = 'nodejs';

/** Pattern-detection cadence the spec recommends (Section 9 reads a 7-day
 *  window from DynamoDB). The caller can override it per invocation. */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 30;

// -----------------------------------------------------------------------------
// Request validation
// -----------------------------------------------------------------------------

interface DetectRequest {
  team_id: string;
  window_days: number;
}

function validateBody(
  body: unknown,
): DetectRequest | { status: 400; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, message: 'Request body must be a JSON object.' };
  }
  const { team_id, window_days } = body as {
    team_id?: unknown;
    window_days?: unknown;
  };
  if (typeof team_id !== 'string' || team_id.length === 0) {
    return { status: 400, message: '`team_id` must be a non-empty string.' };
  }
  let resolvedWindow = DEFAULT_WINDOW_DAYS;
  if (window_days !== undefined) {
    if (
      typeof window_days !== 'number' ||
      !Number.isFinite(window_days) ||
      window_days < 1 ||
      window_days > MAX_WINDOW_DAYS
    ) {
      return {
        status: 400,
        message: `\`window_days\` must be a number between 1 and ${MAX_WINDOW_DAYS}.`,
      };
    }
    resolvedWindow = Math.floor(window_days);
  }
  return { team_id, window_days: resolvedWindow };
}

// -----------------------------------------------------------------------------
// Event window scan
// -----------------------------------------------------------------------------

interface EventRow extends BrowserEvent {
  event_key: string;
}

/**
 * Scan DynamoDB for every event in the window. Uses Query rather than Scan
 * because team_id is the partition key — we can fetch one team's events
 * cheaply without touching other tenants. Paginates via
 * ExclusiveStartKey so we never miss a page on a high-volume team.
 */
async function fetchEvents(
  teamId: string,
  sinceMs: number,
): Promise<BrowserEvent[]> {
  const client = getDynamoClient();
  const items: BrowserEvent[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await client.send(
      new QueryCommand({
        TableName: EVENTS_TABLE_NAME,
        // The sort key is `${timestamp}#${user_id}#${seq}`, so a lexicographic
        // begins-with filter on a single millisecond is meaningless — we use
        // a >= comparison on the prefix instead, knowing that millisecond
        // timestamps are zero-padded to the same width for the next ~25 years.
        KeyConditionExpression: 'team_id = :tid AND event_key >= :since',
        ExpressionAttributeValues: {
          ':tid': teamId,
          ':since': `${sinceMs}`,
        },
        ExclusiveStartKey,
      }),
    );
    for (const item of response.Items ?? []) {
      items.push(item as EventRow);
    }
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

interface ExistingPatternRow {
  pattern_id: string;
  sequence_key: string;
}

/**
 * Load existing patterns for the team keyed by their sequence_key (the same
 * `domain1>domain2` form the detection module emits), so we can skip
 * persisting patterns we already know about.
 */
async function loadExistingPatternKeys(teamId: string): Promise<Set<string>> {
  // The patterns table stores sequence as JSONB; we reproject it back into the
  // detect-module key form here so the two layers stay in sync.
  const result = await query<ExistingPatternRow>(
    `
      SELECT
        pattern_id,
        ARRAY_TO_STRING(ARRAY(SELECT jsonb_array_elements_text(sequence)), '>') AS sequence_key
      FROM patterns
      WHERE team_id = $1
    `,
    [teamId],
  );
  return new Set(result.rows.map((row) => row.sequence_key));
}

interface InsertedPatternRow {
  pattern_id: string;
  team_id: string;
  sequence: string[];
  frequency: number;
  score: string;
  est_hours_monthly: string | null;
  status: PatternStatus;
  detected_at: string;
}

function rowToPattern(row: InsertedPatternRow): Pattern {
  return {
    pattern_id: row.pattern_id,
    team_id: row.team_id,
    sequence: row.sequence,
    frequency: row.frequency,
    score: Number(row.score),
    est_hours_monthly:
      row.est_hours_monthly === null ? null : Number(row.est_hours_monthly),
    status: row.status,
    detected_at: row.detected_at,
  };
}

/**
 * Insert one detected pattern plus its pattern_users attribution rows in a
 * single Aurora transaction so the dashboard can never see a half-written
 * pattern (a row in `patterns` without the matching `pattern_users` rows
 * would render with zero contributing users — visually confusing).
 */
async function persistPattern(
  teamId: string,
  candidate: PatternCandidate,
  estHoursMonthly: number | null,
): Promise<PatternWithUsers> {
  const patternId = `pat_${randomUUID()}`;

  const stored = await transaction(async (txQuery) => {
    const insert = await txQuery<InsertedPatternRow>(
      `
        INSERT INTO patterns (
          pattern_id, team_id, sequence, frequency, score,
          est_hours_monthly, status, detected_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'detected', NOW())
        RETURNING
          pattern_id, team_id, sequence,
          frequency, score::text AS score,
          est_hours_monthly::text AS est_hours_monthly,
          status, detected_at
      `,
      [
        patternId,
        teamId,
        JSON.stringify(candidate.sequence),
        candidate.frequency,
        candidate.score,
        estHoursMonthly,
      ],
    );
    const row = insert.rows[0];
    if (!row) throw new Error('INSERT patterns returned no rows');

    // pattern_users is small — at most teamSize rows per pattern — so we
    // issue one INSERT per attribution rather than building a multi-VALUES
    // statement. Easier to read, no measurable cost at this scale.
    for (const [userId, occurrenceCount] of Object.entries(
      candidate.occurrencesByUser,
    )) {
      await txQuery(
        `
          INSERT INTO pattern_users (pattern_id, user_id, occurrence_count)
          VALUES ($1, $2, $3)
          ON CONFLICT (pattern_id, user_id) DO NOTHING
        `,
        [patternId, userId, occurrenceCount],
      );
    }
    return rowToPattern(row);
  });

  return { ...stored, user_count: candidate.userCount };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body is not valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = validateBody(raw);
  if ('status' in parsed) {
    return NextResponse.json(
      { error: parsed.message },
      { status: parsed.status },
    );
  }
  const { team_id, window_days } = parsed;

  let teamSize = 0;
  try {
    // Reading the team size from `users` keeps the participation term in the
    // score formula accurate even when the team grows between runs.
    const teamResult = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users WHERE team_id = $1',
      [team_id],
    );
    teamSize = Number(teamResult.rows[0]?.count ?? 0);
  } catch (err) {
    console.error('[/api/detect] team-size lookup failed:', err);
    return NextResponse.json(
      { error: 'Failed to load team metadata.' },
      { status: 503 },
    );
  }
  if (teamSize === 0) {
    return NextResponse.json(
      { error: `Team ${team_id} has no registered users.` },
      { status: 404 },
    );
  }

  const sinceMs = Date.now() - window_days * 24 * 60 * 60 * 1000;
  let events: BrowserEvent[];
  try {
    events = await fetchEvents(team_id, sinceMs);
  } catch (err) {
    console.error('[/api/detect] DynamoDB scan failed:', err);
    return NextResponse.json(
      { error: 'Failed to read event window.' },
      { status: 503 },
    );
  }

  const candidates = detectPatterns({ events, teamSize });

  let existing: Set<string>;
  try {
    existing = await loadExistingPatternKeys(team_id);
  } catch (err) {
    console.error('[/api/detect] existing-pattern load failed:', err);
    return NextResponse.json(
      { error: 'Failed to load existing patterns.' },
      { status: 503 },
    );
  }

  const persisted: PatternWithUsers[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    if (existing.has(candidate.key)) {
      skipped += 1;
      continue;
    }

    // Best-effort Haiku interpretation — failures fall back to a null
    // est_hours_monthly so detection still completes when the model is down.
    let estHoursMonthly: number | null = null;
    try {
      const interpretation = await interpretPattern({
        pattern_id: 'preview',
        team_id,
        sequence: candidate.sequence,
        frequency: candidate.frequency,
        score: candidate.score,
        est_hours_monthly: null,
        status: 'detected',
        detected_at: new Date(candidate.firstSeenMs).toISOString(),
      });
      estHoursMonthly = interpretation.est_hours_saved_monthly;
    } catch (err) {
      console.warn(
        `[/api/detect] interpretation failed for ${candidate.key}:`,
        err,
      );
    }

    try {
      const stored = await persistPattern(team_id, candidate, estHoursMonthly);
      persisted.push(stored);

      // Pusher is fire-and-forget per the same policy used elsewhere; a
      // missed realtime push does not roll back the persisted row.
      try {
        await triggerTeamEvent(team_id, {
          name: 'new-pattern',
          payload: stored,
        });
      } catch (err) {
        console.warn(
          `[/api/detect] pusher trigger failed for ${stored.pattern_id}:`,
          err,
        );
      }
    } catch (err) {
      console.error(
        `[/api/detect] persistence failed for ${candidate.key}:`,
        err,
      );
      // Continue processing the rest — one bad candidate must not block
      // the rest of the batch from being detected.
    }
  }

  return NextResponse.json(
    {
      detected: candidates.length,
      persisted: persisted.length,
      skipped,
      patterns: persisted,
    },
    { status: 200 },
  );
}
