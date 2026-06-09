/**
 * Toaster — small toast stack rendered in a fixed corner of the viewport.
 *
 * Used by the realtime feed to surface inbound Pusher events without
 * displacing dashboard content. Plain useState + setTimeout instead of a
 * library because the dashboard only ever shows three event types and the
 * lifecycle is "show for 4 s then fade".
 */
'use client';

import { AnimatePresence, motion } from 'framer-motion';
import * as React from 'react';

import { cn } from '@/lib/utils';

export type ToastTone = 'neutral' | 'success' | 'accent';

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
}

const TONE_STYLES: Record<ToastTone, string> = {
  neutral: 'border-slate-200 bg-white text-slate-900',
  success: 'border-emerald-200 bg-white text-emerald-900',
  accent: 'border-indigo-200 bg-white text-indigo-900',
};

interface ToasterProps {
  toasts: Toast[];
}

export function Toaster({ toasts }: ToasterProps) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-80 max-w-full flex-col gap-2"
    >
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'pointer-events-auto rounded-lg border px-4 py-3 shadow-sm',
              TONE_STYLES[toast.tone],
            )}
          >
            <div className="text-sm font-medium leading-tight">
              {toast.title}
            </div>
            {toast.body ? (
              <div className="mt-1 text-xs leading-snug text-slate-500">
                {toast.body}
              </div>
            ) : null}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
