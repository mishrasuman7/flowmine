/**
 * FlowMine — POST /api/generate-skill
 *
 * The most expensive endpoint in the system. Triggered when an operator
 * clicks "Generate skill" on a detected pattern card. Pipeline:
 *
 *   1. Validate the inbound pattern payload.
 *   2. Call Claude Sonnet to produce a SkillSpec.
 *   3. Compute an OpenAI embedding from the SkillSpec's name + description.
 *   4. Run a pgvector nearest-neighbour search on the team's existing skills;
 *      if a skill within cosine distance < 0.15 (similarity > 0.85) exists,
 *      reject as duplicate so we never spend Sonnet tokens twice on the same
 *      workflow.
 *   5. INSERT the new skill row inside a single Aurora transaction.
 *   6. Mark the source pattern as 'reviewed' so the dashboard stops showing
 *      the original "Generate skill" CTA.
 *   7. Return the persisted Skill.
 *
 * Contract (see types.ts):
 *   Request body: { pattern_id, pattern }
 *   Response 200: { skill }
 *   Response 409: { error } when a near-duplicate skill already exists
 *   Response 4xx/5xx: { error }
 */

import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { query, transaction } from '@/lib/aurora';
import { generateSkill } from '@/lib/claude';
import { embed, toVectorLiteral } from '@/lib/embeddings';
import type {
  GenerateSkillRequest,
  GenerateSkillResponse,
  Pattern,
  PatternStatus,
  Skill,
  SkillSpec,
  SkillStatus,
} from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Maximum cosine distance between the new skill embedding and the nearest
 * existing skill embedding before we treat the new one as a duplicate.
 * pgvector's <=> operator returns cosine distance in [0,2]; 0.15 corresponds
 * to ~0.85 cosine similarity, the dedup threshold listed in the project spec.
 */
const DUPLICATE_DISTANCE_THRESHOLD = 0.15;

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function isPattern(value: unknown): value is Pattern {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pattern_id === 'string' &&
    typeof v.team_id === 'string' &&
    Array.isArray(v.sequence) &&
    v.sequence.every((d) => typeof d === 'string') &&
    typeof v.frequency === 'number' &&
    typeof v.score === 'number' &&
    (v.est_hours_monthly === null || typeof v.est_hours_monthly === 'number') &&
    typeof v.status === 'string' &&
    typeof v.detected_at === 'string'
  );
}

function validateBody(
  body: unknown,
): GenerateSkillRequest | { status: 400; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, message: 'Request body must be a JSON object.' };
  }
  const { pattern_id, pattern } = body as {
    pattern_id?: unknown;
    pattern?: unknown;
  };
  if (typeof pattern_id !== 'string' || pattern_id.length === 0) {
    return { status: 400, message: '`pattern_id` must be a non-empty string.' };
  }
  if (!isPattern(pattern)) {
    return { status: 400, message: '`pattern` failed shape validation.' };
  }
  if (pattern.pattern_id !== pattern_id) {
    return {
      status: 400,
      message: '`pattern_id` does not match `pattern.pattern_id`.',
    };
  }
  return { pattern_id, pattern };
}

// -----------------------------------------------------------------------------
// Aurora row shapes
// -----------------------------------------------------------------------------

interface NearestSkillRow {
  skill_id: string;
  distance: string;
}

interface InsertedSkillRow {
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

function rowToSkill(row: InsertedSkillRow): Skill {
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
  const { pattern_id, pattern } = parsed;

  let spec: SkillSpec;
  try {
    spec = await generateSkill(pattern);
  } catch (err) {
    console.error('[/api/generate-skill] Claude generation failed:', err);
    return NextResponse.json(
      { error: 'Skill generation failed.' },
      { status: 502 },
    );
  }

  let vector: number[];
  try {
    vector = await embed(`${spec.name}\n${spec.description}`);
  } catch (err) {
    console.error('[/api/generate-skill] embedding failed:', err);
    return NextResponse.json(
      { error: 'Embedding generation failed.' },
      { status: 502 },
    );
  }
  const vectorLiteral = toVectorLiteral(vector);

  // Dedup against the same team's existing active or draft skills. We do not
  // dedup across teams — different tenants legitimately end up with similar
  // skills, and surfacing one team's automation to another is a leak.
  try {
    const nearest = await query<NearestSkillRow>(
      `
        SELECT skill_id, (embedding <=> $2::vector)::text AS distance
        FROM skills
        WHERE team_id = $1
          AND status IN ('draft', 'active', 'paused')
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector
        LIMIT 1
      `,
      [pattern.team_id, vectorLiteral],
    );
    const nearestRow = nearest.rows[0];
    if (nearestRow && Number(nearestRow.distance) < DUPLICATE_DISTANCE_THRESHOLD) {
      return NextResponse.json(
        {
          error:
            'A semantically similar skill already exists ' +
            `(skill_id=${nearestRow.skill_id}).`,
        },
        { status: 409 },
      );
    }
  } catch (err) {
    console.error('[/api/generate-skill] dedup query failed:', err);
    return NextResponse.json(
      { error: 'Duplicate check failed.' },
      { status: 503 },
    );
  }

  const skillId = `skl_${randomUUID()}`;
  const reviewedStatus: PatternStatus = 'reviewed';

  try {
    const skill = await transaction(async (txQuery) => {
      const insert = await txQuery<InsertedSkillRow>(
        `
          INSERT INTO skills (
            skill_id, team_id, pattern_id, name, description,
            action_sequence, embedding, status
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector, 'draft')
          RETURNING
            skill_id, team_id, pattern_id, name, description,
            action_sequence, status, success_count, failure_count,
            created_at
        `,
        [
          skillId,
          pattern.team_id,
          pattern_id,
          spec.name,
          spec.description,
          JSON.stringify(spec),
          vectorLiteral,
        ],
      );

      await txQuery(
        'UPDATE patterns SET status = $2 WHERE pattern_id = $1',
        [pattern_id, reviewedStatus],
      );

      const row = insert.rows[0];
      if (!row) {
        throw new Error('INSERT returned no rows');
      }
      return rowToSkill(row);
    });

    const body: GenerateSkillResponse = { skill };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    console.error('[/api/generate-skill] persistence failed:', err);
    return NextResponse.json(
      { error: 'Failed to persist generated skill.' },
      { status: 503 },
    );
  }
}
