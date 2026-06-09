/**
 * SkillCard — a single AI-generated skill in the team's library.
 *
 * Where PatternCard surfaces "we noticed a workflow", SkillCard surfaces "we
 * built an automation for it", and lets the operator move the skill through
 * its lifecycle (draft -> active -> paused -> retired). Status transitions
 * are issued via PATCH /api/skills, which enforces the same state machine
 * on the server so the dashboard cannot smuggle through an illegal move.
 *
 * The success-vs-failure ratio bar across the bottom is the at-a-glance
 * reliability signal — green if the skill is running cleanly, amber if the
 * failure ratio is climbing, slate if no runs yet.
 */
'use client';

import { motion } from 'framer-motion';
import {
  Activity,
  CircleSlash,
  Loader2,
  Pause,
  Play,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Badge, type BadgeVariant } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Skill, SkillStatus } from '@/lib/types';

// -----------------------------------------------------------------------------
// Status visuals
// -----------------------------------------------------------------------------

interface StatusMeta {
  label: string;
  variant: BadgeVariant;
}

const STATUS_META: Record<SkillStatus, StatusMeta> = {
  draft: { label: 'Draft', variant: 'subtle' },
  active: { label: 'Active', variant: 'success' },
  executing: { label: 'Executing', variant: 'accent' },
  paused: { label: 'Paused', variant: 'warning' },
  retired: { label: 'Retired', variant: 'danger' },
};

// -----------------------------------------------------------------------------
// Lifecycle action helpers
// -----------------------------------------------------------------------------

interface ActionDescriptor {
  label: string;
  next: SkillStatus;
  icon: LucideIcon;
  /** Visual rank: primary action is filled, others are outlined. */
  primary?: boolean;
  /** Slot for an extra tone hint, used by Retire to read as destructive. */
  tone?: 'default' | 'destructive';
}

/**
 * Map the current status to the buttons the dashboard offers. Mirrors
 * ALLOWED_TRANSITIONS in the /api/skills PATCH route exactly; the server
 * remains the source of truth, but rendering only legal options client-side
 * keeps the UI honest.
 */
function actionsForStatus(status: SkillStatus): ActionDescriptor[] {
  switch (status) {
    case 'draft':
      return [
        { label: 'Activate', next: 'active', icon: Play, primary: true },
        {
          label: 'Retire',
          next: 'retired',
          icon: CircleSlash,
          tone: 'destructive',
        },
      ];
    case 'active':
      return [
        { label: 'Pause', next: 'paused', icon: Pause, primary: true },
        {
          label: 'Retire',
          next: 'retired',
          icon: CircleSlash,
          tone: 'destructive',
        },
      ];
    case 'paused':
      return [
        { label: 'Resume', next: 'active', icon: Play, primary: true },
        {
          label: 'Retire',
          next: 'retired',
          icon: CircleSlash,
          tone: 'destructive',
        },
      ];
    case 'executing':
    case 'retired':
      // executing transitions back to active on its own when the run finishes;
      // retired is terminal. Both render no buttons.
      return [];
  }
}

// -----------------------------------------------------------------------------
// Success ratio bar
// -----------------------------------------------------------------------------

interface ReliabilityBarProps {
  successes: number;
  failures: number;
}

function ReliabilityBar({ successes, failures }: ReliabilityBarProps) {
  const total = successes + failures;
  if (total === 0) {
    return (
      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
        <span>No runs yet</span>
        <span className="font-mono">0 / 0</span>
      </div>
    );
  }
  const successPct = Math.round((successes / total) * 100);
  const failureWeight = failures / total;
  const tone =
    failureWeight === 0
      ? 'bg-emerald-500'
      : failureWeight < 0.15
        ? 'bg-emerald-400'
        : failureWeight < 0.35
          ? 'bg-amber-400'
          : 'bg-rose-500';
  return (
    <div className="mt-1 space-y-1">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={successes}
      >
        <div
          className={cn('h-full transition-all', tone)}
          style={{ width: `${successPct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>{successPct}% success</span>
        <span className="font-mono">
          {successes} / {total}
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// SkillCard
// -----------------------------------------------------------------------------

interface SkillCardProps {
  skill: Skill;
  index?: number;
}

export function SkillCard({ skill, index = 0 }: SkillCardProps) {
  const [current, setCurrent] = React.useState<Skill>(skill);
  const [pending, setPending] = React.useState<SkillStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const meta = STATUS_META[current.status];
  const actions = actionsForStatus(current.status);
  const actionCount = current.action_sequence?.actions?.length ?? 0;
  const estimatedHumanMs =
    current.action_sequence?.estimated_human_time_ms ?? 0;
  const estimatedHumanMinutes = estimatedHumanMs / 60_000;

  async function transitionTo(next: SkillStatus): Promise<void> {
    setPending(next);
    setError(null);
    try {
      const response = await fetch('/api/skills', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_id: current.skill_id, status: next }),
      });
      const body = (await response.json().catch(() => null)) as
        | { skill?: Skill; error?: string }
        | null;
      if (!response.ok || !body?.skill) {
        setError(body?.error ?? `HTTP ${response.status}`);
        return;
      }
      setCurrent(body.skill);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.32,
        ease: [0.22, 1, 0.36, 1],
        delay: Math.min(index, 8) * 0.04,
      }}
    >
      <Card className="flex h-full flex-col">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <Badge variant={meta.variant}>
              {current.status === 'executing' ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : null}
              {meta.label}
            </Badge>
            <Badge variant="subtle">
              <Activity className="h-3 w-3" aria-hidden />
              {actionCount} step{actionCount === 1 ? '' : 's'}
            </Badge>
          </div>
          <CardTitle className="mt-2">{current.name}</CardTitle>
          {current.description ? (
            <CardDescription className="line-clamp-2">
              {current.description}
            </CardDescription>
          ) : null}
        </CardHeader>

        <CardContent className="flex-1 space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div className="flex flex-col">
              <dt className="text-slate-500">Manual time</dt>
              <dd className="mt-1 text-base font-semibold text-slate-900">
                {estimatedHumanMinutes > 0
                  ? `${estimatedHumanMinutes.toFixed(1)} min`
                  : '—'}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-slate-500">Created</dt>
              <dd className="mt-1 text-sm font-medium text-slate-700">
                <time dateTime={current.created_at}>
                  {new Date(current.created_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </dd>
            </div>
          </dl>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Reliability
            </div>
            <ReliabilityBar
              successes={current.success_count}
              failures={current.failure_count}
            />
          </div>
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-2">
          {error ? (
            <p
              className="text-xs text-rose-600"
              role="alert"
              title={error}
            >
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {actions.length === 0 ? (
              <span className="text-[11px] text-slate-500">
                No actions available
              </span>
            ) : (
              actions.map((action) => {
                const Icon = action.icon;
                const busy = pending === action.next;
                return (
                  <button
                    key={action.next}
                    type="button"
                    onClick={() => void transitionTo(action.next)}
                    disabled={pending !== null}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ' +
                        'text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      action.primary
                        ? 'border border-slate-900 bg-slate-900 text-white hover:bg-slate-800'
                        : action.tone === 'destructive'
                          ? 'border border-rose-200 bg-white text-rose-700 hover:bg-rose-50'
                          : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {action.label}
                  </button>
                );
              })
            )}
          </div>
        </CardFooter>
      </Card>
    </motion.div>
  );
}
