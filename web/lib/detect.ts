/**
 * FlowMine — pattern detection algorithm (pure).
 *
 * Section 9 of the project spec, implemented as a single pure function so it
 * can be exercised offline against the JSON output of scripts/seed-events.ts
 * and reused unchanged in:
 *   - the /api/detect Next.js route (HTTP-triggered, for the demo),
 *   - the future AWS Lambda triggered by DynamoDB Streams.
 *
 * No database access, no AWS calls, no Pusher. Input: an array of
 * BrowserEvent. Output: scored candidate patterns the caller can persist.
 *
 * Algorithm:
 *   1. Group events by user_id, sort each group by timestamp.
 *   2. Split each user's timeline into sessions (gap > SESSION_GAP_MS = 5 min
 *      starts a new session).
 *   3. Within every session, extract every contiguous domain subsequence of
 *      length k for k in {2, 3, 4}. Skip a candidate if it contains the same
 *      domain twice in a row (a refresh, not a workflow step).
 *   4. Aggregate occurrences across all users into a histogram keyed by the
 *      stringified domain sequence.
 *   5. For each unique subsequence, compute:
 *        f = total occurrences
 *        u = distinct users who produced it
 *        c = consistency: normalised stddev of time-of-day (in hours) over
 *            the [0, 24) clock, dampened by domain. Lower stddev = more
 *            consistent timing = more automatable.
 *        score = log(1 + f) * (u / teamSize) * (1 - c)
 *   6. Filter: score >= scoreThreshold AND u >= MIN_USERS AND f >= MIN_FREQ.
 */

import type { BrowserEvent } from '@/lib/types';

// -----------------------------------------------------------------------------
// Tuning constants
// -----------------------------------------------------------------------------

/** Match the extension's session boundary so detection sees the same sessions
 *  the capture layer recorded. */
export const SESSION_GAP_MS = 5 * 60 * 1000;

/** Subsequence lengths considered (Section 9: k = 2, 3, 4). */
export const SUBSEQUENCE_LENGTHS = [2, 3, 4] as const;

export const MIN_FREQ = 3;
export const MIN_USERS = 2;
export const DEFAULT_SCORE_THRESHOLD = 0.15;

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface DetectionInput {
  /** Raw event window read from DynamoDB or the seed JSON. */
  events: ReadonlyArray<BrowserEvent>;
  /** Distinct user count for the team — denominator of the participation
   *  term in the score formula. */
  teamSize: number;
  /** Override the default 0.15 threshold; used by tests to inspect lower
   *  scoring candidates without rewriting the filter. */
  scoreThreshold?: number;
}

export interface PatternCandidate {
  /** Deterministic stable key, useful for dedup against existing rows. */
  key: string;
  /** Domain sequence in execution order. */
  sequence: string[];
  /** Total occurrence count across the team. */
  frequency: number;
  /** Distinct users who produced at least one occurrence. */
  userCount: number;
  /** Per-user occurrence counts, ready to write into pattern_users rows. */
  occurrencesByUser: Record<string, number>;
  /** Final ranking score. */
  score: number;
  /** Normalised stddev of time-of-day, in [0, 1]; surfaced so the dashboard
   *  can show "consistent 9 am workflow" badges. */
  consistency: number;
  /** Earliest occurrence timestamp; the route uses this to bound the
   *  `detected_at` value or to skip already-persisted patterns. */
  firstSeenMs: number;
  /** Latest occurrence timestamp. */
  lastSeenMs: number;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface Occurrence {
  user_id: string;
  /** Time-of-day expressed in hours [0, 24), used to score consistency. */
  hourOfDay: number;
  /** Absolute timestamp of the first event in this occurrence. */
  startMs: number;
}

/**
 * Group events by user_id, dropping events that lack a usable timestamp.
 * Returns the per-user arrays sorted ascending by timestamp.
 */
function groupByUser(
  events: ReadonlyArray<BrowserEvent>,
): Map<string, BrowserEvent[]> {
  const byUser = new Map<string, BrowserEvent[]>();
  for (const event of events) {
    if (!event.user_id || !event.domain) continue;
    let bucket = byUser.get(event.user_id);
    if (!bucket) {
      bucket = [];
      byUser.set(event.user_id, bucket);
    }
    bucket.push(event);
  }
  for (const bucket of byUser.values()) {
    bucket.sort((a, b) => a.timestamp - b.timestamp);
  }
  return byUser;
}

/**
 * Slice a single user's chronological events into sessions, where a gap
 * larger than SESSION_GAP_MS between consecutive events starts a new session.
 */
function sessionise(events: BrowserEvent[]): BrowserEvent[][] {
  const sessions: BrowserEvent[][] = [];
  let current: BrowserEvent[] = [];
  for (const event of events) {
    const last = current[current.length - 1];
    if (last && event.timestamp - last.timestamp > SESSION_GAP_MS) {
      if (current.length > 0) sessions.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

/**
 * Compute time-of-day (in hours) from an absolute timestamp. Uses UTC so the
 * algorithm is stable across operator machines; the absolute clock is
 * irrelevant — only its consistency across occurrences matters.
 */
function hourOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

/**
 * Normalised standard deviation of an array of hour-of-day values in
 * [0, 1]. Treats the day as a circle by computing the stddev around the
 * circular mean — a workflow that occasionally spans 23:30 -> 00:30 should
 * not look randomly distributed.
 */
function circularConsistency(hours: number[]): number {
  if (hours.length < 2) return 0;

  // Convert hours to angles on the unit circle (24 hours = 2*pi radians).
  const radians = hours.map((h) => (h / 24) * 2 * Math.PI);
  let sinSum = 0;
  let cosSum = 0;
  for (const r of radians) {
    sinSum += Math.sin(r);
    cosSum += Math.cos(r);
  }
  const meanLength = Math.sqrt(sinSum * sinSum + cosSum * cosSum) / hours.length;

  // Circular variance is 1 - meanLength; a perfectly clustered set has
  // meanLength ~= 1 and variance ~= 0. Map straight through to [0, 1].
  return 1 - meanLength;
}

function patternKey(sequence: readonly string[]): string {
  return sequence.join('>');
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Run pattern detection over the provided event window.
 *
 * Output is sorted by descending score, so the caller can persist the top N
 * without an extra sort.
 */
export function detectPatterns(input: DetectionInput): PatternCandidate[] {
  const scoreThreshold = input.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const byUser = groupByUser(input.events);

  // Accumulator: every observed subsequence -> the list of every occurrence
  // we have seen anywhere on the team. We collect each occurrence so the
  // scoring step can compute user_count and consistency in one pass.
  const accumulator = new Map<string, Occurrence[]>();

  for (const [userId, events] of byUser) {
    const sessions = sessionise(events);
    for (const session of sessions) {
      // A session of length n contributes (n - k + 1) subsequences for each
      // window size k <= n.
      for (const k of SUBSEQUENCE_LENGTHS) {
        if (session.length < k) continue;
        for (let i = 0; i + k <= session.length; i += 1) {
          const window = session.slice(i, i + k);
          const sequence = window.map((event) => event.domain);

          // Skip windows where the same domain repeats consecutively — that
          // is almost always a reload or in-page navigation, not a workflow
          // step worth automating.
          let collapsed = false;
          for (let j = 1; j < sequence.length; j += 1) {
            if (sequence[j] === sequence[j - 1]) {
              collapsed = true;
              break;
            }
          }
          if (collapsed) continue;

          const key = patternKey(sequence);
          let occurrences = accumulator.get(key);
          if (!occurrences) {
            occurrences = [];
            accumulator.set(key, occurrences);
          }
          const startMs = window[0]?.timestamp ?? 0;
          occurrences.push({
            user_id: userId,
            hourOfDay: hourOfDay(startMs),
            startMs,
          });
        }
      }
    }
  }

  const candidates: PatternCandidate[] = [];

  for (const [key, occurrences] of accumulator) {
    const frequency = occurrences.length;
    if (frequency < MIN_FREQ) continue;

    const occurrencesByUser: Record<string, number> = {};
    for (const occurrence of occurrences) {
      occurrencesByUser[occurrence.user_id] =
        (occurrencesByUser[occurrence.user_id] ?? 0) + 1;
    }
    const userCount = Object.keys(occurrencesByUser).length;
    if (userCount < MIN_USERS) continue;

    const consistency = circularConsistency(
      occurrences.map((occurrence) => occurrence.hourOfDay),
    );
    const participation =
      input.teamSize > 0 ? userCount / input.teamSize : 0;
    const score = Math.log1p(frequency) * participation * (1 - consistency);
    if (score < scoreThreshold) continue;

    const startTimes = occurrences.map((occurrence) => occurrence.startMs);
    candidates.push({
      key,
      sequence: key.split('>'),
      frequency,
      userCount,
      occurrencesByUser,
      score: Number(score.toFixed(4)),
      consistency: Number(consistency.toFixed(4)),
      firstSeenMs: Math.min(...startTimes),
      lastSeenMs: Math.max(...startTimes),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// -----------------------------------------------------------------------------
// Test exports — only consumed by tests/dev tools, not by route handlers
// -----------------------------------------------------------------------------

export const __internals = {
  groupByUser,
  sessionise,
  hourOfDay,
  circularConsistency,
  patternKey,
};
