/**
 * Dashboard home — server-rendered overview that lists detected patterns and
 * the team's active skills. Reads directly from Aurora rather than calling
 * /api/patterns + /api/skills via HTTP because we are already inside the same
 * runtime; the extra hop would only cost latency and another JSON parse.
 *
 * When Aurora is unreachable (the typical developer state until AWS credits
 * land) the page renders an EmptyState explaining how to connect, so the
 * route stays viewable even before infrastructure provisioning.
 */
import * as React from 'react';

import { PatternList } from '@/components/PatternList';
import { ROIChart } from '@/components/ROIChart';
import { SkillList } from '@/components/SkillList';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { query } from '@/lib/aurora';
import type {
  PatternStatus,
  PatternWithUsers,
  Skill,
  SkillStatus,
  SkillSpec,
} from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

interface DashboardData {
  patterns: PatternWithUsers[];
  skills: Skill[];
  error: string | null;
}

async function loadDashboard(teamId: string): Promise<DashboardData> {
  try {
    const [patterns, skills] = await Promise.all([
      query<PatternRow>(
        `
          SELECT
            p.pattern_id, p.team_id, p.sequence, p.frequency,
            p.score::text AS score,
            p.est_hours_monthly::text AS est_hours_monthly,
            p.status, p.detected_at,
            COALESCE(u.user_count, 0)::text AS user_count
          FROM patterns p
          LEFT JOIN (
            SELECT pattern_id, COUNT(DISTINCT user_id) AS user_count
            FROM pattern_users GROUP BY pattern_id
          ) u ON u.pattern_id = p.pattern_id
          WHERE p.team_id = $1
          ORDER BY p.score DESC, p.detected_at DESC
        `,
        [teamId],
      ),
      query<SkillRow>(
        `
          SELECT
            skill_id, team_id, pattern_id, name, description,
            action_sequence, status, success_count, failure_count, created_at
          FROM skills
          WHERE team_id = $1 AND status <> 'retired'
          ORDER BY created_at DESC
        `,
        [teamId],
      ),
    ]);

    return {
      patterns: patterns.rows.map((row) => ({
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
      })),
      skills: skills.rows,
      error: null,
    };
  } catch (err) {
    return {
      patterns: [],
      skills: [],
      error: (err as Error).message,
    };
  }
}

// -----------------------------------------------------------------------------
// Small subcomponents kept inline so the page reads top-to-bottom
// -----------------------------------------------------------------------------

function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs text-slate-500">{hint}</div>
      ) : null}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle?: string;
  count?: number;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {subtitle ? (
          <p className="text-sm text-slate-500">{subtitle}</p>
        ) : null}
      </div>
      {typeof count === 'number' ? (
        <Badge variant="subtle">
          {count} {count === 1 ? 'item' : 'items'}
        </Badge>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default async function DashboardPage() {
  const teamId = process.env.TEAM_ID ?? 'demo_team_001';
  const data = await loadDashboard(teamId);

  const activeSkills = data.skills.filter((s) => s.status === 'active').length;
  const monthlyHours = data.patterns.reduce(
    (sum, p) => sum + (p.est_hours_monthly ?? 0),
    0,
  );

  return (
    <div className="flex flex-col gap-10">
      <div>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Operator overview
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Patterns the AI workforce has detected across your team and the
              skills generated from them.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryStat
            label="Patterns detected"
            value={data.patterns.length}
            hint="Across your most recent activity window"
          />
          <SummaryStat
            label="Active skills"
            value={activeSkills}
            hint={`${data.skills.length} total in library`}
          />
          <SummaryStat
            label="Hours saved / month"
            value={monthlyHours.toFixed(1)}
            hint="Estimated across detected patterns"
          />
        </div>
      </div>

      {data.error || data.patterns.length === 0 ? null : (
        <ROIChart patterns={data.patterns} />
      )}

      {data.error ? (
        <EmptyState
          title="Aurora is unreachable"
          description={
            'The dashboard could not read patterns or skills. ' +
            'Set AURORA_HOST, AURORA_USERNAME, and AURORA_PASSWORD in ' +
            'web/.env.local once the cluster is up; this view will populate ' +
            'automatically on next reload.'
          }
        />
      ) : (
        <section>
          <SectionHeader
            title="Detected patterns"
            subtitle="Ranked by automation score. Higher means stronger candidate."
            count={data.patterns.length}
          />
          {data.patterns.length === 0 ? (
            <EmptyState
              title="No patterns detected yet"
              description={
                'Once browser events flow in and POST /api/detect runs, the ' +
                'top-scoring workflows will appear here.'
              }
            />
          ) : (
            <PatternList patterns={data.patterns} />
          )}
        </section>
      )}

      {data.error ? null : (
        <section>
          <SectionHeader
            title="Skill library"
            subtitle="AI-generated automations. Activate one to let the agent run it."
            count={data.skills.length}
          />
          {data.skills.length === 0 ? (
            <EmptyState
              title="No skills yet"
              description={
                'Generate a skill from a detected pattern above to populate the ' +
                'library. Skills can be paused or retired at any time.'
              }
            />
          ) : (
            <SkillList skills={data.skills} />
          )}
        </section>
      )}
    </div>
  );
}
