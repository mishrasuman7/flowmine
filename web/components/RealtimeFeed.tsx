/**
 * RealtimeFeed — mounts a Pusher subscription for the operator's team and
 * keeps the dashboard in sync with server-side state changes.
 *
 * Triggers:
 *   - new-pattern         pattern-detection Lambda just landed a new pattern
 *   - skill-activated     an operator (possibly in another tab) flipped a
 *                         skill into the active state
 *   - execution-complete  the extension finished running a skill
 *
 * For each event we:
 *   1. Push a toast through the small in-component queue so the operator
 *      sees a real-time notification regardless of where they are scrolled.
 *   2. Call router.refresh(), which tells Next.js to re-fetch the server
 *      component data without losing client state. The page-level data load
 *      in app/dashboard/page.tsx runs again, the new pattern (or updated
 *      skill) lands in props, and the existing AnimatePresence wrappers on
 *      PatternList and SkillList slide the changes into place.
 *
 * Using router.refresh() instead of mutating local state means the
 * dashboard is never out of sync with Aurora — if the Pusher payload
 * disagrees with the database for any reason (race condition, retry
 * window) the database wins on the next paint.
 */
'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Toaster, type Toast } from '@/components/Toaster';
import { getPusherBrowser } from '@/lib/pusher-client';
import {
  teamChannel,
  type PatternWithUsers,
  type Skill,
  type SkillExecution,
} from '@/lib/types';

interface RealtimeFeedProps {
  teamId: string;
}

/** How long each toast stays in view before it fades. */
const TOAST_TTL_MS = 4000;

export function RealtimeFeed({ teamId }: RealtimeFeedProps) {
  const router = useRouter();
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const pushToast = React.useCallback((toast: Omit<Toast, 'id'>): void => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((existing) => existing.id !== id));
    }, TOAST_TTL_MS);
  }, []);

  React.useEffect(() => {
    const pusher = getPusherBrowser();
    if (!pusher) {
      // No credentials or running outside the browser; render silently
      // so the dashboard is still usable during development.
      return undefined;
    }

    const channel = pusher.subscribe(teamChannel(teamId));

    const onNewPattern = (payload: PatternWithUsers): void => {
      pushToast({
        title: 'New pattern detected',
        body: payload.sequence.join(' → '),
        tone: 'neutral',
      });
      router.refresh();
    };

    const onSkillActivated = (payload: Skill): void => {
      pushToast({
        title: 'Skill activated',
        body: payload.name,
        tone: 'success',
      });
      router.refresh();
    };

    const onExecutionComplete = (payload: SkillExecution): void => {
      pushToast({
        title: payload.success ? 'Skill run finished' : 'Skill run failed',
        body:
          payload.duration_ms !== null
            ? `${(payload.duration_ms / 1000).toFixed(1)} s`
            : undefined,
        tone: payload.success ? 'success' : 'accent',
      });
      router.refresh();
    };

    channel.bind('new-pattern', onNewPattern);
    channel.bind('skill-activated', onSkillActivated);
    channel.bind('execution-complete', onExecutionComplete);

    return () => {
      channel.unbind('new-pattern', onNewPattern);
      channel.unbind('skill-activated', onSkillActivated);
      channel.unbind('execution-complete', onExecutionComplete);
      pusher.unsubscribe(teamChannel(teamId));
    };
  }, [teamId, router, pushToast]);

  return <Toaster toasts={toasts} />;
}
