/**
 * PatternList — placeholder stub.
 *
 * The full Framer Motion grid implementation lands in the next commit
 * together with PatternCard. This stub exists so the dashboard shell page
 * compiles and renders a coherent "loaded but skeletal" state.
 */
'use client';

import type { PatternWithUsers } from '@/lib/types';

interface PatternListProps {
  patterns: PatternWithUsers[];
}

export function PatternList({ patterns }: PatternListProps) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {patterns.map((pattern) => (
        <li
          key={pattern.pattern_id}
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <p className="text-sm font-medium text-slate-900">
            {pattern.sequence.join(' → ')}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {pattern.frequency} occurrences · {pattern.user_count} users ·
            score {pattern.score.toFixed(2)}
          </p>
        </li>
      ))}
    </ul>
  );
}
