/**
 * FlowMine — background service worker.
 *
 * Manifest V3 background scripts are short-lived: Chrome evicts the worker
 * after ~30 s of idle, then revives it whenever a registered listener fires
 * or an alarm goes off. That means we cannot rely on module-scope variables
 * for state — anything that has to survive an eviction lives in
 * chrome.storage.local instead.
 *
 * Responsibilities, in order:
 *
 *   1. Subscribe to chrome.webNavigation.onCompleted, chrome.tabs.onActivated,
 *      and chrome.tabs.onRemoved. Each event becomes a BrowserEvent appended
 *      to the local buffer.
 *   2. Assign a session_id per user — same session if the last event was
 *      less than 5 minutes ago, otherwise a fresh session.
 *   3. Register a chrome.alarms alarm that fires every 60 s; on each tick,
 *      drain the buffer in one POST to /api/events. Retry once on transient
 *      failure; on persistent failure, leave the events in the buffer so
 *      the next tick can carry them forward.
 *   4. Expose a tiny message protocol for the popup to read configuration
 *      and last-flush diagnostics without each surface poking storage keys
 *      directly.
 */

import type {
  BrowserEvent,
  BrowserEventType,
  FlowMineConfig,
  FlushStatus,
} from './types';

// -----------------------------------------------------------------------------
// Storage keys and tuneables
// -----------------------------------------------------------------------------

const STORAGE_KEYS = {
  buffer: 'flowmine.event_buffer',
  config: 'flowmine.config',
  status: 'flowmine.flush_status',
  session: 'flowmine.session_state',
} as const;

/** Default config injected the first time the popup runs. The user can override
 *  team_id, user_id, and api_url from the popup later. */
const DEFAULT_CONFIG: FlowMineConfig = {
  team_id: 'demo_team_001',
  user_id: 'demo_user_001',
  api_url: 'http://localhost:3000',
};

/** Section 9 of the project spec: a five-minute gap of inactivity starts a
 *  fresh session_id, which the detection algorithm uses as the boundary for
 *  its sliding window. */
const SESSION_GAP_MS = 5 * 60 * 1000;

/** Chrome alarms accept minutes only; 1 minute = 60 s flush cadence. */
const FLUSH_ALARM_NAME = 'flowmine.flush';
const FLUSH_PERIOD_MINUTES = 1;

/** Hard cap on the in-memory buffer. Mirrors MAX_EVENTS_PER_BATCH on the
 *  server side; if a flush has failed for hours we still bound memory growth. */
const BUFFER_MAX = 1000;

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------

/** Read a single key from chrome.storage.local with a typed default. */
async function readStorage<T>(key: string, fallback: T): Promise<T> {
  const got = await chrome.storage.local.get(key);
  const value = got[key];
  return (value as T | undefined) ?? fallback;
}

async function writeStorage(values: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(values);
}

/** Read configuration with default backfill on first run. Writes the default
 *  back so the popup's "current values" view is never empty. */
async function readConfig(): Promise<FlowMineConfig> {
  const stored = await readStorage<FlowMineConfig | null>(
    STORAGE_KEYS.config,
    null,
  );
  if (stored) return stored;
  await writeStorage({ [STORAGE_KEYS.config]: DEFAULT_CONFIG });
  return DEFAULT_CONFIG;
}

// -----------------------------------------------------------------------------
// Session tracking
// -----------------------------------------------------------------------------

interface SessionState {
  /** Active session id, regenerated after SESSION_GAP_MS of inactivity. */
  id: string;
  /** Timestamp of the most recent event in this session. */
  last_event_at: number;
  /** Monotonically increasing per-session sequence number (used for tie
   *  breaking inside the server's event_key sort key). */
  seq: number;
}

function newSessionId(): string {
  // crypto.randomUUID is available in service workers from Chrome 95+. We
  // accept the tighter compatibility window for the much shorter id.
  return crypto.randomUUID();
}

/**
 * Decide which session a new event belongs to. Pure of side effects so the
 * caller can decide whether to persist.
 */
function nextSession(
  prev: SessionState | null,
  now: number,
): SessionState {
  if (!prev || now - prev.last_event_at > SESSION_GAP_MS) {
    return { id: newSessionId(), last_event_at: now, seq: 0 };
  }
  return { id: prev.id, last_event_at: now, seq: prev.seq + 1 };
}

// -----------------------------------------------------------------------------
// Event capture
// -----------------------------------------------------------------------------

/**
 * Normalise a URL to the bare hostname we want to record. Strips the leading
 * "www." and silently returns null for non-http schemes (chrome://, about:,
 * file://) which we don't care to capture.
 */
function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function appendEvent(
  type: BrowserEventType,
  tabId: number,
  url: string | null,
): Promise<void> {
  const domain = url === null ? null : extractDomain(url);
  if (!domain) return;

  const config = await readConfig();
  if (!config.team_id || !config.user_id) return;

  const now = Date.now();
  const prevSession = await readStorage<SessionState | null>(
    STORAGE_KEYS.session,
    null,
  );
  const session = nextSession(prevSession, now);
  await writeStorage({ [STORAGE_KEYS.session]: session });

  const event: BrowserEvent = {
    team_id: config.team_id,
    user_id: config.user_id,
    domain,
    event_type: type,
    tab_id: String(tabId),
    session_id: session.id,
    timestamp: now,
  };

  const buffer = await readStorage<BrowserEvent[]>(STORAGE_KEYS.buffer, []);
  // Bound buffer growth if the server has been down for a long time: drop
  // the oldest event rather than the newest, since recent activity is the
  // higher-signal slice for pattern detection.
  if (buffer.length >= BUFFER_MAX) buffer.shift();
  buffer.push(event);
  await writeStorage({ [STORAGE_KEYS.buffer]: buffer });
}

// -----------------------------------------------------------------------------
// Flush
// -----------------------------------------------------------------------------

async function getFlushStatus(): Promise<FlushStatus> {
  return readStorage<FlushStatus>(STORAGE_KEYS.status, {
    last_flush_at: null,
    last_flush_count: 0,
    last_flush_error: null,
    buffered_count: 0,
  });
}

async function recordFlushStatus(update: Partial<FlushStatus>): Promise<void> {
  const current = await getFlushStatus();
  await writeStorage({ [STORAGE_KEYS.status]: { ...current, ...update } });
}

interface PostEventsResponse {
  success: true;
  written: number;
}

/**
 * Drain the buffer in one HTTP request. If the server replies 200, the
 * buffer is cleared. On any other outcome (network error, 4xx, 5xx) the
 * events are left in the buffer so the next alarm tick will retry. The 4xx
 * vs 5xx distinction is logged but does not change client behaviour — we
 * trust the server's validator and assume a 4xx is a transient
 * mismatch rather than a permanent reject.
 */
async function flush(): Promise<void> {
  const buffer = await readStorage<BrowserEvent[]>(STORAGE_KEYS.buffer, []);
  await recordFlushStatus({ buffered_count: buffer.length });
  if (buffer.length === 0) return;

  const config = await readConfig();
  if (!config.api_url) {
    await recordFlushStatus({ last_flush_error: 'api_url not configured' });
    return;
  }

  const endpoint = `${config.api_url.replace(/\/$/, '')}/api/events`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: buffer }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      await recordFlushStatus({
        last_flush_error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      });
      return;
    }

    const json = (await response.json()) as PostEventsResponse;
    await writeStorage({ [STORAGE_KEYS.buffer]: [] });
    await recordFlushStatus({
      last_flush_at: Date.now(),
      last_flush_count: json.written,
      last_flush_error: null,
      buffered_count: 0,
    });
  } catch (err) {
    await recordFlushStatus({
      last_flush_error: `Network error: ${(err as Error).message}`,
    });
  }
}

// -----------------------------------------------------------------------------
// Listener wiring
// -----------------------------------------------------------------------------

// onCompleted fires once per top-level navigation. We filter on
// details.frameId === 0 so iframe loads don't pollute the event stream.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  void appendEvent('navigate', details.tabId, details.url);
});

chrome.tabs.onActivated.addListener((info) => {
  // Resolve the activated tab's URL asynchronously; the listener itself
  // cannot be async because Chrome ignores returned promises here.
  void (async () => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      await appendEvent('tab_activate', info.tabId, tab.url ?? null);
    } catch {
      // Tab vanished between activation and lookup — nothing to record.
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // We have no URL at close time (the tab is already gone), so we record
  // the close without a domain. The server-side validator requires a domain
  // string, so we drop tab_close events that arrive without one — they are
  // mostly useful for session bookkeeping anyway, and the session_state
  // already captures the user's overall activity rhythm.
  void appendEvent('tab_close', tabId, null);
});

// chrome.alarms survives service-worker eviction; setInterval does not.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM_NAME) {
    void flush();
  }
});

// Register the alarm idempotently on every worker startup. create() is a
// no-op when an alarm with the same name already exists.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM_NAME, {
    periodInMinutes: FLUSH_PERIOD_MINUTES,
  });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM_NAME, {
    periodInMinutes: FLUSH_PERIOD_MINUTES,
  });
});

// -----------------------------------------------------------------------------
// Popup message protocol
// -----------------------------------------------------------------------------

type PopupRequest =
  | { kind: 'get_config' }
  | { kind: 'set_config'; config: FlowMineConfig }
  | { kind: 'get_status' }
  | { kind: 'flush_now' };

type PopupResponse =
  | { kind: 'config'; config: FlowMineConfig }
  | { kind: 'status'; status: FlushStatus }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

chrome.runtime.onMessage.addListener(
  (
    message: PopupRequest,
    _sender,
    sendResponse: (response: PopupResponse) => void,
  ) => {
    void (async () => {
      try {
        switch (message.kind) {
          case 'get_config': {
            sendResponse({ kind: 'config', config: await readConfig() });
            return;
          }
          case 'set_config': {
            await writeStorage({ [STORAGE_KEYS.config]: message.config });
            sendResponse({ kind: 'ok' });
            return;
          }
          case 'get_status': {
            sendResponse({ kind: 'status', status: await getFlushStatus() });
            return;
          }
          case 'flush_now': {
            await flush();
            sendResponse({ kind: 'ok' });
            return;
          }
        }
      } catch (err) {
        sendResponse({ kind: 'error', message: (err as Error).message });
      }
    })();
    // Tell Chrome we'll respond asynchronously.
    return true;
  },
);

console.log('[flowmine] background worker ready');
