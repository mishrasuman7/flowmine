/**
 * Badge primitive — small variant-based pill for status, scores, and counts.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'neutral'
  | 'subtle'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent';

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-900 text-white border-slate-900',
  subtle: 'bg-slate-100 text-slate-700 border-slate-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-rose-50 text-rose-700 border-rose-200',
  accent: 'bg-indigo-50 text-indigo-700 border-indigo-200',
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({
  className,
  variant = 'subtle',
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ' +
          'text-xs font-medium leading-none whitespace-nowrap',
        VARIANT_STYLES[variant],
        className,
      )}
      {...props}
    />
  );
}
