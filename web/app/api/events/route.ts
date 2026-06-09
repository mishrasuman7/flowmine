/**
 * FlowMine — POST /api/events
 *
 * Entry point for the Chrome extension's batched browser-event uploads. The
 * extension buffers events locally and flushes a batch every 60 seconds; on a
 * 5xx response it re-queues the batch and retries. This route's job is to
 * validate the payload and hand the events off to the DynamoDB writer.
 *
 * Contract (see types.ts):
 *   Request body:  { events: BrowserEvent[] }
 *   Response 200:  { success: true, written: number }
 *   Response 4xx:  { error: string }
 *   Response 5xx:  { error: string } — extension will retry
 */

import { NextResponse } from 'next/server';

import { batchWriteEvents } from '@/lib/dynamodb';
import type {
  BrowserEvent,
  BrowserEventType,
  PostEventsRequest,
  PostEventsResponse,
} from '@/lib/types';

// -----------------------------------------------------------------------------
// Runtime configuration
// -----------------------------------------------------------------------------

/**
 * Force the Node.js runtime so the AWS SDK (which depends on Node-specific
 * APIs and tls) works correctly on Vercel. The Edge runtime would silently
 * fall back to fetch transport and lose connection reuse.
 */
export const runtime = 'nodejs';

/**
 * Hard ceiling on the number of events accepted in one batch. The DynamoDB
 * BatchWrite limit is 25 per request and we chunk internally, but a single
 * HTTP request carrying tens of thousands of events would still chew up
 * function memory and Lambda time. The extension caps its own batches at 500;
 * 1000 here gives headroom without inviting abuse.
 */
const MAX_EVENTS_PER_BATCH = 1000;

/** Whitelist of event types the extension is allowed to send. */
const ALLOWED_EVENT_TYPES: ReadonlySet<BrowserEventType> = new Set<BrowserEventType>([
  'navigate',
  'tab_activate',
  'tab_close',
]);

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Narrow an arbitrary unknown into a BrowserEvent. We do this by hand rather
 * than pull in a validator library — the shape is small, fixed, and lives in
 * a single critical-path endpoint where dependency weight matters.
 */
function isBrowserEvent(value: unknown): value is BrowserEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.team_id === 'string' &&
    v.team_id.length > 0 &&
    typeof v.user_id === 'string' &&
    v.user_id.length > 0 &&
    typeof v.domain === 'string' &&
    v.domain.length > 0 &&
    typeof v.event_type === 'string' &&
    ALLOWED_EVENT_TYPES.has(v.event_type as BrowserEventType) &&
    typeof v.tab_id === 'string' &&
    typeof v.session_id === 'string' &&
    typeof v.timestamp === 'number' &&
    Number.isFinite(v.timestamp) &&
    v.timestamp > 0
  );
}

interface ValidationError {
  readonly status: 400;
  readonly message: string;
}

function validateBody(
  body: unknown,
): { events: BrowserEvent[] } | ValidationError {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, message: 'Request body must be a JSON object.' };
  }
  const { events } = body as { events?: unknown };
  if (!Array.isArray(events)) {
    return { status: 400, message: 'Body field `events` must be an array.' };
  }
  if (events.length === 0) {
    return { status: 400, message: 'Body field `events` must be non-empty.' };
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return {
      status: 400,
      message:
        `Batch too large: ${events.length} events (max ` +
        `${MAX_EVENTS_PER_BATCH}).`,
    };
  }
  for (let i = 0; i < events.length; i += 1) {
    if (!isBrowserEvent(events[i])) {
      return {
        status: 400,
        message: `events[${i}] failed shape validation.`,
      };
    }
  }
  return { events: events as BrowserEvent[] };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body is not valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = validateBody(raw);
  if ('status' in parsed) {
    return NextResponse.json(
      { error: parsed.message },
      { status: parsed.status },
    );
  }

  try {
    const written = await batchWriteEvents(parsed.events);
    const body: PostEventsResponse = { success: true, written };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    console.error('[/api/events] batch write failed:', err);
    return NextResponse.json(
      { error: 'Failed to persist events. Retry the batch.' },
      { status: 503 },
    );
  }
}

// Type-only re-export so the request payload shape stays discoverable from
// the route file itself when reading the code top-to-bottom.
export type { PostEventsRequest };
