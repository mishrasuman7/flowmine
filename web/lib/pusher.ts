/**
 * FlowMine — Pusher server client.
 *
 * Wraps the `pusher` SDK so server-side code (pattern-detection Lambda,
 * /api/skills PATCH handler, /api/execute) can push realtime updates to the
 * operator dashboard without each call site repeating the env-var plumbing
 * and channel-naming convention.
 *
 * Client-side Pusher (pusher-js) is initialised separately inside the
 * dashboard component; this file is server-only.
 */

import Pusher from 'pusher';

import {
  teamChannel,
  type PusherEvent,
} from '@/lib/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const APP_ID = process.env.PUSHER_APP_ID;
const KEY = process.env.NEXT_PUBLIC_PUSHER_KEY;
const SECRET = process.env.PUSHER_SECRET;
const CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER ?? 'eu';

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __flowminePusher: Pusher | undefined;
}

function getPusher(): Pusher {
  if (!globalThis.__flowminePusher) {
    if (!APP_ID || !KEY || !SECRET) {
      throw new Error(
        'Pusher env vars missing: set PUSHER_APP_ID, NEXT_PUBLIC_PUSHER_KEY, ' +
          'and PUSHER_SECRET before triggering realtime events.',
      );
    }
    globalThis.__flowminePusher = new Pusher({
      appId: APP_ID,
      key: KEY,
      secret: SECRET,
      cluster: CLUSTER,
      // TLS-only transport so secrets never cross the wire in plaintext,
      // even on developer machines.
      useTLS: true,
    });
  }
  return globalThis.__flowminePusher;
}

// -----------------------------------------------------------------------------
// Typed trigger helper
// -----------------------------------------------------------------------------

/**
 * Publish a realtime event to the given team's channel. The `event` argument is
 * the discriminated PusherEvent union from @/lib/types, which means the
 * `payload` shape is automatically narrowed by the event `name` at the call
 * site — callers cannot accidentally send a Skill payload under the
 * `new-pattern` event name.
 *
 * Pusher quietly swallows network errors when fire-and-forget; we surface them
 * to the caller instead so a failed publish does not silently desync the
 * dashboard from the underlying database state.
 */
export async function triggerTeamEvent(
  teamId: string,
  event: PusherEvent,
): Promise<void> {
  const client = getPusher();
  await client.trigger(teamChannel(teamId), event.name, event.payload);
}

export { getPusher };
