/**
 * FlowMine — /api/skills
 *
 * Two verbs share one route file because they target the same resource:
 *
 *   GET   /api/skills?team_id=...        — list skills for a team
 *   PATCH /api/skills                    — transition a skill's status
 *
 * The dashboard uses GET to populate the skill library and PATCH when an
 * operator clicks Activate, Pause, or Retire on a skill card. A status
 * transition that ends in `active` also fires a Pusher event so every other
 * dashboard tab the operator might have open reflects the change immediately.
 */

import { NextResponse } from 'next/server';

import { query } from '@/lib/aurora';
import { triggerTeamEvent } from '@/lib/pusher';
import {
  type GetSkillsResponse,
  type PatchSkillRequest,
  type PatchSkillResponse,
  type Skill,
  type SkillSpec,
  type SkillStatus,
} from '@/lib/types';

export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Shared row -> Skill mapper
// -----------------------------------------------------------------------------

interface SkillRow {
  skill_id: string;
  team_id: string;
  pattern_id: string | null;
  name: string;
  description: string | null;
  action_sequence: SkillSpec;
  status: SkillStatus;
  success_count: number;
  failure_count: number;
  created_at: string;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    skill_id: row.skill_id,
    team_id: row.team_id,
    pattern_id: row.pattern_id,
    name: row.name,
    description: row.description,
    action_sequence: row.action_sequence,
    status: row.status,
    success_count: row.success_count,
    failure_count: row.failure_count,
    created_at: row.created_at,
  };
}

/**
 * Project list: every Skill column except the 1536-dim embedding vector.
 * Sending the embedding to the dashboard would balloon the response payload
 * with no UI gain — embeddings are server-side only.
 */
const SKILL_SELECT = `
  skill_id, team_id, pattern_id, name, description,
  action_sequence, status, success_count, failure_count, created_at
`;

// -----------------------------------------------------------------------------
// GET: list skills for a team
// -----------------------------------------------------------------------------

const VISIBLE_STATUSES: ReadonlySet<SkillStatus> = new Set<SkillStatus>([
  'draft',
  'active',
  'executing',
  'paused',
]);

export async function GET(request: Request): Promise<NextResponse> {
  const teamId = new URL(request.url).searchParams.get('team_id');
  if (!teamId) {
    return NextResponse.json(
      { error: 'Query param `team_id` is required.' },
      { status: 400 },
    );
  }

  try {
    // Filter out retired skills by default; the dashboard's skill library
    // does not show them. A future ?include_retired=1 toggle can extend this
    // without breaking the existing contract.
    const visible = [...VISIBLE_STATUSES];
    const result = await query<SkillRow>(
      `
        SELECT ${SKILL_SELECT}
        FROM skills
        WHERE team_id = $1
          AND status = ANY($2::text[])
        ORDER BY created_at DESC
      `,
      [teamId, visible],
    );

    const body: GetSkillsResponse = { skills: result.rows.map(rowToSkill) };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    console.error('[/api/skills GET] query failed:', err);
    return NextResponse.json(
      { error: 'Failed to load skills.' },
      { status: 503 },
    );
  }
}

// -----------------------------------------------------------------------------
// PATCH: transition a skill's status
// -----------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Readonly<Record<SkillStatus, ReadonlySet<SkillStatus>>> = {
  draft: new Set<SkillStatus>(['active', 'retired']),
  active: new Set<SkillStatus>(['paused', 'retired']),
  paused: new Set<SkillStatus>(['active', 'retired']),
  // `executing` is a transient state set by the executor itself; the
  // dashboard cannot move out of it. `retired` is terminal.
  executing: new Set<SkillStatus>(['active']),
  retired: new Set<SkillStatus>(),
};

const SKILL_STATUS_VALUES: ReadonlySet<SkillStatus> = new Set<SkillStatus>([
  'draft',
  'active',
  'executing',
  'paused',
  'retired',
]);

function isSkillStatus(value: unknown): value is SkillStatus {
  return typeof value === 'string' && SKILL_STATUS_VALUES.has(value as SkillStatus);
}

function validatePatchBody(
  body: unknown,
): PatchSkillRequest | { status: 400; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, message: 'Request body must be a JSON object.' };
  }
  const { skill_id, status } = body as {
    skill_id?: unknown;
    status?: unknown;
  };
  if (typeof skill_id !== 'string' || skill_id.length === 0) {
    return { status: 400, message: '`skill_id` must be a non-empty string.' };
  }
  if (!isSkillStatus(status)) {
    return {
      status: 400,
      message:
        `\`status\` must be one of: ` +
        `${[...SKILL_STATUS_VALUES].join(', ')}.`,
    };
  }
  return { skill_id, status };
}

export async function PATCH(request: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body is not valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = validatePatchBody(raw);
  if ('status' in parsed && 'message' in parsed) {
    return NextResponse.json(
      { error: parsed.message },
      { status: parsed.status },
    );
  }
  const { skill_id, status: nextStatus } = parsed;

  let current: SkillRow | undefined;
  try {
    const before = await query<SkillRow>(
      `SELECT ${SKILL_SELECT} FROM skills WHERE skill_id = $1`,
      [skill_id],
    );
    current = before.rows[0];
  } catch (err) {
    console.error('[/api/skills PATCH] lookup failed:', err);
    return NextResponse.json(
      { error: 'Failed to load skill before update.' },
      { status: 503 },
    );
  }

  if (!current) {
    return NextResponse.json({ error: 'Skill not found.' }, { status: 404 });
  }

  const allowed = ALLOWED_TRANSITIONS[current.status];
  if (!allowed.has(nextStatus)) {
    return NextResponse.json(
      {
        error:
          `Illegal transition: ${current.status} -> ${nextStatus}. ` +
          `Allowed: ${[...allowed].join(', ') || '(none)'}.`,
      },
      { status: 409 },
    );
  }

  let updated: Skill;
  try {
    const result = await query<SkillRow>(
      `
        UPDATE skills
        SET status = $2
        WHERE skill_id = $1
        RETURNING ${SKILL_SELECT}
      `,
      [skill_id, nextStatus],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('UPDATE returned no rows');
    }
    updated = rowToSkill(row);
  } catch (err) {
    console.error('[/api/skills PATCH] update failed:', err);
    return NextResponse.json(
      { error: 'Failed to update skill.' },
      { status: 503 },
    );
  }

  // Fire a realtime nudge only when the transition matters to other open
  // dashboards. We intentionally do not block the response on Pusher — if
  // realtime is unavailable, the persistent state is still correct and the
  // next manual refresh will reconcile.
  if (nextStatus === 'active') {
    try {
      await triggerTeamEvent(updated.team_id, {
        name: 'skill-activated',
        payload: updated,
      });
    } catch (err) {
      console.error('[/api/skills PATCH] pusher trigger failed:', err);
    }
  }

  const body: PatchSkillResponse = { skill: updated };
  return NextResponse.json(body, { status: 200 });
}
