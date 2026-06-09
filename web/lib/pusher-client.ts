/**
 * FlowMine — Pusher browser client.
 *
 * Server-side Pusher (the `pusher` package) lives in web/lib/pusher.ts.
 * This module is its mirror for the browser: a single `pusher-js` instance
 * cached on the window so React Strict Mode double-mounts and Next.js
 * route transitions do not open multiple parallel WebSocket connections to
 * the same channel.
 *
 * Only the public NEXT_PUBLIC_PUSHER_KEY and NEXT_PUBLIC_PUSHER_CLUSTER env
 * vars are read — the server secret is never shipped to the browser.
 */

'use client';

import Pusher from 'pusher-js';

declare global {
  interface Window {
    __flowminePusherClient?: Pusher;
  }
}

const KEY = process.env.NEXT_PUBLIC_PUSHER_KEY;
const CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER ?? 'eu';

/**
 * Lazily build (or return) the browser Pusher instance. Returns null when
 * the public key is missing — callers fall back to silent no-op subscribe
 * helpers so the dashboard still renders cleanly during development before
 * Pusher credentials are configured.
 */
export function getPusherBrowser(): Pusher | null {
  if (typeof window === 'undefined') return null;
  if (!KEY) return null;
  if (!window.__flowminePusherClient) {
    window.__flowminePusherClient = new Pusher(KEY, {
      cluster: CLUSTER,
      // Force secure WebSocket transport so the connection is encrypted on
      // every network the operator might be on (cafe wifi, conference
      // hotspot, etc.). Pusher's default falls back to plain WS if SSL
      // negotiation fails, which we don't want.
      forceTLS: true,
    });
  }
  return window.__flowminePusherClient;
}
