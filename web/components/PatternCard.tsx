/**
 * PatternCard — a single detected workflow pattern surfaced on the dashboard.
 *
 * Pattern cards are the central artefact the operator interacts with: each
 * one represents a repeated browser workflow the detection algorithm found,
 * and clicking "Generate skill" turns it into an executable AI skill via
 * /api/generate-skill. The visual emphasis is on three pieces of information
 * the operator decides on:
 *
 *   - the sequence of domains the workflow walks through,
 *   - how broadly adopted it is across the team,
 *   - the estimated monthly hours saved if automated.
 *
 * Framer Motion handles the reveal-on-mount animation so newly detected
 * patterns (whether on page load or via a Pusher push later) slide into
 * view rather than popping in.
 */
'use client';

import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ChevronRight,
  Clock,
  Loader2,
  Sparkles,
  Users,
} from 'lucide-react';
import * as React from 'react';

import { Badge, type BadgeVariant } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { PatternWithUsers } from '@/lib/types';

// -----------------------------------------------------------------------------
// Visual mappings
// -----------------------------------------------------------------------------

/**
 * Map a continuous detection score onto a small palette of variants so the
 * card surfaces "this is a strong candidate" without the operator having to
 * read the raw number.
 */
function scoreVariant(score: number): BadgeVariant {
  if (score >= 3) return 'success';
  if (score >= 1.5) return 'accent';
  return 'subtle';
}

function scoreLabel(score: number): string {
  if (score >= 3) return 'Top candidate';
  if (score >= 1.5) return 'Strong candidate';
  return 'Candidate';
}

/**
 * Status pill copy — the API returns three lifecycle states but the dashboard
 * only ever surfaces detected and reviewed; discarded patterns are filtered
 * out upstream.
 */
function statusBadge(status: PatternWithUsers['status']): {
  variant: BadgeVariant;
  label: string;
} {
  switch (status) {
    case 'detected':
      return { variant: 'neutral', label: 'New' };
    case 'reviewed':
      return { variant: 'subtle', label: 'In library' };
    case 'discarded':
      return { variant: 'danger', label: 'Discarded' };
  }
}

// -----------------------------------------------------------------------------
// Sequence renderer
// -----------------------------------------------------------------------------

/**
 * Render the domain chain as horizontal pill-with-arrow chips. The first chip
 * gets visual weight so the entry point of the workflow stands out, and the
 * arrow between chips reinforces sequence (vs. just a set).
 */
function SequenceChain({ sequence }: { sequence: readonly string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {sequence.map((domain, idx) => (
        <React.Fragment key={`${domain}-${idx}`}>
          <li
            className={cn(
              'rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 ' +
                'font-mono text-xs text-slate-700',
              idx === 0 && 'border-slate-300 bg-white font-medium text-slate-900',
            )}
          >
            {domain}
          </li>
          {idx < sequence.length - 1 ? (
            <ArrowRight
              className="h-3.5 w-3.5 shrink-0 text-slate-400"
              aria-hidden
            />
          ) : null}
        </React.Fragment>
      ))}
    </ol>
  );
}

// -----------------------------------------------------------------------------
// Skill generation action
// -----------------------------------------------------------------------------

interface GenerateButtonProps {
  pattern: PatternWithUsers;
}

function GenerateButton({ pattern }: GenerateButtonProps) {
  const router = useRouter();
  const [state, setState] = React.useState<
    'idle' | 'generating' | 'done' | 'error'
  >('idle');
  const [message, setMessage] = React.useState<string | null>(null);

  // `reviewed` patterns already have a skill, so the CTA is hidden in that
  // case and replaced by a calmer "already in library" affordance.
  if (pattern.status === 'reviewed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> Skill in library
      </span>
    );
  }

  const onClick = async (): Promise<void> => {
    setState('generating');
    setMessage(null);
    try {
      const response = await fetch('/api/generate-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern_id: pattern.pattern_id,
          pattern,
        }),
      });
      if (response.ok) {
        setState('done');
        // Re-fetch the server component data so the newly generated skill
        // appears in the Skill library section immediately, without the
        // operator having to manually reload the page.
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setMessage(body?.error ?? `HTTP ${response.status}`);
      setState('error');
    } catch (err) {
      setMessage((err as Error).message);
      setState('error');
    }
  };

  return (
    <div className="flex items-center gap-3">
      {message ? (
        <span className="max-w-[180px] truncate text-xs text-rose-600" title={message}>
          {message}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onClick}
        disabled={state === 'generating' || state === 'done'}
        className={cn(
          'group inline-flex items-center gap-1.5 rounded-md ' +
            'border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs ' +
            'font-medium text-white transition-colors',
          'hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {state === 'generating' ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Generating…
          </>
        ) : state === 'done' ? (
          <>
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Generated
          </>
        ) : (
          <>
            Generate skill
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </>
        )}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PatternCard
// -----------------------------------------------------------------------------

interface PatternCardProps {
  pattern: PatternWithUsers;
  /** Stagger position for the reveal animation when many cards mount at once. */
  index?: number;
}

export function PatternCard({ pattern, index = 0 }: PatternCardProps) {
  const status = statusBadge(pattern.status);
  const hours = pattern.est_hours_monthly;

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
            <div className="flex items-center gap-2">
              <Badge variant={scoreVariant(pattern.score)}>
                {scoreLabel(pattern.score)}
              </Badge>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <span
              className="font-mono text-[11px] text-slate-400"
              title={`Score ${pattern.score}`}
            >
              {pattern.score.toFixed(2)}
            </span>
          </div>
          <div className="mt-3">
            <SequenceChain sequence={pattern.sequence} />
          </div>
        </CardHeader>

        <CardContent className="flex-1">
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <div className="flex flex-col">
              <dt className="text-slate-500">Occurrences</dt>
              <dd className="mt-1 text-base font-semibold text-slate-900">
                {pattern.frequency}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="flex items-center gap-1 text-slate-500">
                <Users className="h-3 w-3" aria-hidden /> Users
              </dt>
              <dd className="mt-1 text-base font-semibold text-slate-900">
                {pattern.user_count}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="flex items-center gap-1 text-slate-500">
                <Clock className="h-3 w-3" aria-hidden /> Hours / mo
              </dt>
              <dd className="mt-1 text-base font-semibold text-slate-900">
                {hours === null ? '—' : hours.toFixed(1)}
              </dd>
            </div>
          </dl>
        </CardContent>

        <CardFooter>
          <span className="text-[11px] text-slate-500">
            Detected{' '}
            <time dateTime={pattern.detected_at}>
              {new Date(pattern.detected_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </span>
          <GenerateButton pattern={pattern} />
        </CardFooter>
      </Card>
    </motion.div>
  );
}
