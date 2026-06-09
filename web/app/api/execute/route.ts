/**
 * FlowMine — POST /api/execute
 *
 * Called by the Chrome extension at the end of every skill run. Persists the
 * outcome to skill_executions, bumps success_count or failure_count on the
 * parent skill row, and publishes a realtime nudge so dashboards can update
 * their ROI charts and success-rate widgets without polling.
 *
 * Idempotency is the caller's responsibility (the extension generates a
 * client-side execution_id and re-uses it on retry). We do not enforce it
 * server-side because a duplicate POST is far less harmful here than a lost
 * execution log would be — execution counts are summary stats, not ledger
 * balances.
 *
 * Contract (see types.ts):
 *   Request body: { skill_id, user_id, success, duration_ms }
 *   Response 200: { execution }
 *   Response 4xx/5xx: { error }
 */

import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { transaction } from '@/lib/aurora';
import { triggerTeamEvent } from '@/lib/pusher';
import type {
  PostExecuteRequest,
  PostExecuteResponse,
  SkillExecution,
} from '@/lib/types';

export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function validateBody(
  body: unknown,
): PostExecuteRequest | { status: 400; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, message: 'Request body must be a JSON object.' };
  }
  const { skill_id, user_id, success, duration_ms } = body as {
    skill_id?: unknown;
    user_id?: unknown;
    success?: unknown;
    duration_ms?: unknown;
  };
  if (typeof skill_id !== 'string' || skill_id.length === 0) {
    return { status: 400, message: '`skill_id` must be a non-empty string.' };
  }
  if (typeof user_id !== 'string' || user_id.length === 0) {
    return { status: 400, message: '`user_id` must be a non-empty string.' };
  }
  if (typeof success !== 'boolean') {
    return { status: 400, message: '`success` must be a boolean.' };
  }
  if (
    typeof duration_ms !== 'number' ||
    !Number.isFinite(duration_ms) ||
    duration_ms < 0
  ) {
    return {
      status: 400,
      message: '`duration_ms` must be a non-negative finite number.',
    };
  }
  return { skill_id, user_id, success, duration_ms };
}

// -----------------------------------------------------------------------------
// Aurora row shape
// -----------------------------------------------------------------------------

interface ExecutionRow {
  execution_id: string;
  skill_id: string;
  user_id: string;
  success: boolean;
  duration_ms: number | null;
  executed_at: string;
}

function rowToExecution(row: ExecutionRow): SkillExecution {
  return {
    execution_id: row.execution_id,
    skill_id: row.skill_id,
    user_id: row.user_id,
    success: row.success,
    duration_ms: row.duration_ms,
    executed_at: row.executed_at,
  };
}

interface SkillTeamRow {
  team_id: string;
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
  const { skill_id, user_id, success, duration_ms } = parsed;

  const executionId = `exe_${randomUUID()}`;
  let execution: SkillExecution;
  let teamId: string;

  try {
    const result = await transaction(async (txQuery) => {
      const insert = await txQuery<ExecutionRow>(
        `
          INSERT INTO skill_executions (
            execution_id, skill_id, user_id, success, duration_ms
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING execution_id, skill_id, user_id, success,
                    duration_ms, executed_at
        `,
        [executionId, skill_id, user_id, success, duration_ms],
      );
      const row = insert.rows[0];
      if (!row) throw new Error('INSERT returned no rows');

      // Bump the matching counter on the parent skill, scoping by skill_id
      // and returning team_id in the same round-trip so we can target the
      // Pusher channel without a separate SELECT.
      const counterColumn = success ? 'success_count' : 'failure_count';
      const skillUpdate = await txQuery<SkillTeamRow>(
        `
          UPDATE skills
          SET ${counterColumn} = ${counterColumn} + 1
          WHERE skill_id = $1
          RETURNING team_id
        `,
        [skill_id],
      );
      const skillRow = skillUpdate.rows[0];
      if (!skillRow) {
        // The skill was deleted between extension dispatch and server receipt.
        // We let the execution row stand (telemetry has value even when the
        // parent is gone) but throw so the transaction rolls back.
        throw new Error(`Skill ${skill_id} not found`);
      }

      return { execution: rowToExecution(row), teamId: skillRow.team_id };
    });
    execution = result.execution;
    teamId = result.teamId;
  } catch (err) {
    console.error('[/api/execute] persistence failed:', err);
    const message = (err as Error).message ?? '';
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'Failed to record execution.' },
      { status: 503 },
    );
  }

  // Pusher push is fire-and-forget from the response's point of view; a
  // realtime hiccup must not prevent the executor from receiving its 200
  // and clearing its in-flight tracking.
  try {
    await triggerTeamEvent(teamId, {
      name: 'execution-complete',
      payload: execution,
    });
  } catch (err) {
    console.error('[/api/execute] pusher trigger failed:', err);
  }

  const body: PostExecuteResponse = { execution };
  return NextResponse.json(body, { status: 200 });
}
