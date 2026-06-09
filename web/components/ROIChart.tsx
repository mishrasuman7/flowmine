/**
 * ROIChart — 12-month projected hours-saved curve.
 *
 * Aggregates est_hours_monthly across every detected pattern, then projects
 * a cumulative hours-saved line over the next 12 months so the operator can
 * see "what's the return if I activate everything?" in one glance. The
 * staircase curve assumes a steady cadence: every month the team saves an
 * additional `total_monthly` hours, so cumulative at month N is
 * `total_monthly * N`. We keep the projection model deliberately simple —
 * a fancier S-curve would imply forecast precision we don't have.
 *
 * Behaviour:
 *   - When every pattern's est_hours_monthly is null (Haiku interpretation
 *     hasn't run yet), we render an explanatory empty card instead of a
 *     misleading zero line.
 *   - The component is client-only because Recharts uses ResponsiveContainer
 *     which depends on the window object.
 */
'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { PatternWithUsers } from '@/lib/types';

// -----------------------------------------------------------------------------
// Data shaping
// -----------------------------------------------------------------------------

const PROJECTION_MONTHS = 12;

interface ChartPoint {
  /** Month index from the current month (0 = current month). */
  index: number;
  /** Short month label rendered on the X axis. */
  month: string;
  /** Cumulative hours saved by end of this month. */
  cumulativeHours: number;
}

function buildSeries(monthlyHours: number): ChartPoint[] {
  const points: ChartPoint[] = [];
  const now = new Date();
  for (let i = 0; i < PROJECTION_MONTHS; i += 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    points.push({
      index: i,
      month: monthDate.toLocaleString(undefined, { month: 'short' }),
      cumulativeHours: Number((monthlyHours * (i + 1)).toFixed(1)),
    });
  }
  return points;
}

// -----------------------------------------------------------------------------
// Custom tooltip
// -----------------------------------------------------------------------------

/**
 * Recharts v3's Tooltip content receives a loosely typed bag of props; we
 * narrow the shape we actually use rather than fight the upstream union.
 */
interface RechartsTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ value?: number | string }>;
  label?: string | number;
}

function ChartTooltip({ active, payload, label }: RechartsTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const raw = payload[0]?.value;
  const value = typeof raw === 'number' ? raw : 0;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-slate-700">{label}</div>
      <div className="text-slate-500">
        Cumulative:{' '}
        <span className="font-semibold text-slate-900">
          {value.toLocaleString(undefined, {
            maximumFractionDigits: 1,
          })}{' '}
          hours
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface ROIChartProps {
  patterns: PatternWithUsers[];
}

export function ROIChart({ patterns }: ROIChartProps) {
  const monthlyHours = patterns.reduce(
    (sum, p) => sum + (p.est_hours_monthly ?? 0),
    0,
  );
  const series = buildSeries(monthlyHours);
  const annual = series[series.length - 1]?.cumulativeHours ?? 0;

  if (monthlyHours <= 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Hours saved — 12 month projection</CardTitle>
          <CardDescription>
            Once Claude Haiku interprets the detected patterns, this curve
            populates automatically.
          </CardDescription>
        </CardHeader>
        <div className="px-5 pb-6 text-sm text-slate-500">
          No estimated hours yet.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between gap-4">
          <div>
            <CardTitle>Hours saved — 12 month projection</CardTitle>
            <CardDescription>
              Cumulative hours saved across detected workflows if every pattern
              were automated and run at the observed cadence.
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              At month 12
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
              {annual.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              <span className="ml-1 text-sm font-normal text-slate-500">
                hours
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <div className="px-2 pb-4">
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series}
              margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="flowmine-roi" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0f172a" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#0f172a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="2 4"
                stroke="#e2e8f0"
                vertical={false}
              />
              <XAxis
                dataKey="month"
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={42}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#cbd5f5' }} />
              <Area
                type="monotone"
                dataKey="cumulativeHours"
                stroke="#0f172a"
                strokeWidth={2}
                fill="url(#flowmine-roi)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}
