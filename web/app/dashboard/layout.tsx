/**
 * Dashboard layout — shared chrome (header + container) for every page nested
 * under /dashboard. Server component, so it can read env on the way through
 * without shipping any JS to the client.
 */
import Link from 'next/link';
import * as React from 'react';

import { RealtimeFeed } from '@/components/RealtimeFeed';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const teamId = process.env.TEAM_ID ?? 'demo_team_001';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <Link
              href="/"
              className="text-sm font-semibold uppercase tracking-wider text-slate-900"
            >
              FlowMine
            </Link>
            <span className="text-xs text-slate-400">/ dashboard</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-slate-500">
              Team{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                {teamId}
              </code>
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      <RealtimeFeed teamId={teamId} />
    </div>
  );
}
