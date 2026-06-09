/**
 * FlowMine — GET /api/patterns
 *
 * Returns the list of detected workflow patterns for a team, ordered by score
 * descending so the dashboard can render the highest-value automation
 * candidates at the top. Each row carries the distinct user_count joined in
 * from pattern_users so the dashboard does not need a second round-trip to
 * decide whether to surface a pattern card.
 *
 * Contract (see types.ts):
 *   Query params:
 *     team_id (required) — the tenant scope
 *     status  (optional) — 'detected' | 'reviewed' | 'discarded'
 *   Response 200: { patterns: PatternWithUsers[] }
 *   Response 4xx: { error: string }
 *   Response 5xx: { error: string }
 */

import { NextResponse } from 'next/server';

import { query } from '@/lib/aurora';
import type {
  GetPatternsResponse,
  PatternStatus,
  PatternWithUsers,
} from '@/lib/types';

export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const ALLOWED_STATUSES: ReadonlySet<PatternStatus> = new Set<PatternStatus>([
  'detected',
  'reviewed',
  'discarded',
]);

function isAllowedStatus(value: string): value is PatternStatus {
  return ALLOWED_STATUSES.has(value as PatternStatus);
}

/**
 * Shape of one row returned by the SQL below. Aurora's JSONB columns come
 * back as already-decoded JS values via node-postgres, so `sequence` arrives
 * as a real string[]; numeric and timestamp columns become string by default
 * to preserve precision, which we map back into our Pattern shape here.
 */
interface PatternRow {
  pattern_id: string;
  team_id: string;
  sequence: string[];
  frequency: number;
  score: string;
  est_hours_monthly: string | null;
  status: PatternStatus;
  detected_at: string;
  user_count: string;
}

function rowToPattern(row: PatternRow): PatternWithUsers {
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
    user_count: Number(row.user_count),
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const teamId = url.searchParams.get('team_id');
  const statusParam = url.searchParams.get('status');

  if (!teamId) {
    return NextResponse.json(
      { error: 'Query param `team_id` is required.' },
      { status: 400 },
    );
  }

  let statusFilter: PatternStatus | null = null;
  if (statusParam !== null) {
    if (!isAllowedStatus(statusParam)) {
      return NextResponse.json(
        {
          error:
            `Invalid status filter \`${statusParam}\`. ` +
            `Allowed: ${[...ALLOWED_STATUSES].join(', ')}.`,
        },
        { status: 400 },
      );
    }
    statusFilter = statusParam;
  }

  // LEFT JOIN against a COUNT(DISTINCT user_id) aggregation so patterns with
  // zero attribution rows still surface (frequency==1 brand-new patterns
  // briefly land in this state between INSERT into patterns and the followup
  // INSERT into pattern_users). COALESCE keeps user_count numeric.
  const sql = `
    SELECT
      p.pattern_id,
      p.team_id,
      p.sequence,
      p.frequency,
      p.score::text       AS score,
      p.est_hours_monthly::text AS est_hours_monthly,
      p.status,
      p.detected_at,
      COALESCE(u.user_count, 0)::text AS user_count
    FROM patterns p
    LEFT JOIN (
      SELECT pattern_id, COUNT(DISTINCT user_id) AS user_count
      FROM pattern_users
      GROUP BY pattern_id
    ) u ON u.pattern_id = p.pattern_id
    WHERE p.team_id = $1
      AND ($2::text IS NULL OR p.status = $2)
    ORDER BY p.score DESC, p.detected_at DESC
  `;

  try {
    const result = await query<PatternRow>(sql, [teamId, statusFilter]);
    const patterns = result.rows.map(rowToPattern);
    const body: GetPatternsResponse = { patterns };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    console.error('[/api/patterns] query failed:', err);
    return NextResponse.json(
      { error: 'Failed to load patterns.' },
      { status: 503 },
    );
  }
}
