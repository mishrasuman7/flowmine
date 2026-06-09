/**
 * EmptyState — uniform placeholder for "no data yet" and "database unreachable"
 * surfaces on the dashboard, so all empty states share the same vocabulary.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg ' +
          'border border-dashed border-slate-200 bg-slate-50/50 p-10 ' +
          'text-center',
        className,
      )}
    >
      {icon ? <div className="text-slate-400">{icon}</div> : null}
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? (
        <p className="max-w-md text-xs text-slate-500">{description}</p>
      ) : null}
    </div>
  );
}
