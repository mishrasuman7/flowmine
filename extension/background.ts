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
  ActionResult,
  BrowserEvent,
  BrowserEventType,
  ExtensionMessage,
  ExtensionResponse,
  FlowMineConfig,
  FlushStatus,
  Skill,
  SkillAction,
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
// Skill execution
// -----------------------------------------------------------------------------

/** How long we wait for chrome.tabs.update to finish a navigation. The page
 *  is considered ready once webNavigation.onCompleted fires for the top
 *  frame; the executor proceeds to the next action immediately after. */
const NAVIGATE_TIMEOUT_MS = 20_000;

/** How long we wait for the content script to acknowledge a sendMessage
 *  before treating the action as failed. Generous, because some pages take
 *  noticeable time to settle before the content script's listener is up. */
const ACTION_TIMEOUT_MS = 35_000;

/**
 * Resolve when the active tab finishes loading the URL we just navigated
 * to. Rather than rely on chrome.tabs.update's optional callback (which
 * fires before the page is parseable), we listen for the matching
 * webNavigation.onCompleted on the same tab + top frame.
 */
function waitForNavigation(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.webNavigation.onCompleted.removeListener(listener);
      reject(new Error(`Navigation to ${url} timed out`));
    }, NAVIGATE_TIMEOUT_MS);

    const listener = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ): void => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(listener);
      resolve();
    };
    chrome.webNavigation.onCompleted.addListener(listener);
  });
}

/**
 * Forward a SkillAction to the content script in the given tab and wait
 * for the ActionResult. Wraps Chrome's sendMessage in a Promise so the
 * caller can await it, and adds a timeout so a missing listener does not
 * hang the executor forever.
 */
function dispatchToContent(
  tabId: number,
  action: SkillAction,
): Promise<ActionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ActionResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({
        success: false,
        error: `Content script did not respond within ${ACTION_TIMEOUT_MS}ms`,
      });
    }, ACTION_TIMEOUT_MS);

    const message: ExtensionMessage = { kind: 'execute_action', action };
    chrome.tabs.sendMessage(tabId, message, (response: ExtensionResponse) => {
      clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        settle({
          success: false,
          error: lastError.message ?? 'chrome.tabs.sendMessage failed',
        });
        return;
      }
      if (response && response.kind === 'action_result') {
        settle(response.result);
        return;
      }
      settle({
        success: false,
        error: 'Unexpected response from content script',
      });
    });
  });
}

/**
 * Execute one Skill end to end on the currently active tab. Walks the
 * SkillSpec.actions array, dispatching each action to the appropriate
 * handler (background-owned navigate, or content-script-owned everything
 * else), and stops at the first failure.
 *
 * Returns { success, duration_ms, error? } so the caller can decide
 * whether to surface a toast and what to POST to /api/execute.
 */
async function executeSkill(
  skill: Skill,
): Promise<{ success: boolean; duration_ms: number; error?: string }> {
  const started = Date.now();

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) {
    return {
      success: false,
      duration_ms: Date.now() - started,
      error: 'No active tab to run the skill in',
    };
  }
  const tabId = tab.id;

  for (const action of skill.action_sequence.actions) {
    if (action.type === 'navigate') {
      try {
        await chrome.tabs.update(tabId, { url: action.url });
        await waitForNavigation(tabId, action.url);
      } catch (err) {
        return {
          success: false,
          duration_ms: Date.now() - started,
          error: (err as Error).message,
        };
      }
      continue;
    }
    const result = await dispatchToContent(tabId, action);
    if (!result.success) {
      return {
        success: false,
        duration_ms: Date.now() - started,
        error: result.error ?? `Action ${action.type} failed`,
      };
    }
  }

  return { success: true, duration_ms: Date.now() - started };
}

/**
 * Pull the team's skills from the server and keep only active ones — those
 * are the only safe candidates for one-click execution from the popup.
 * Failures surface as an empty list so the popup degrades to "no skills
 * found" rather than throwing.
 */
async function fetchActiveSkills(): Promise<Skill[]> {
  const config = await readConfig();
  if (!config.api_url || !config.team_id) return [];
  const endpoint =
    `${config.api_url.replace(/\/$/, '')}/api/skills` +
    `?team_id=${encodeURIComponent(config.team_id)}`;
  try {
    const response = await fetch(endpoint);
    if (!response.ok) return [];
    const json = (await response.json()) as { skills?: Skill[] };
    return (json.skills ?? []).filter((skill) => skill.status === 'active');
  } catch {
    return [];
  }
}

/**
 * POST the execution result back to /api/execute so the server can persist
 * the row, bump counters, and broadcast execution-complete via Pusher.
 * Best-effort — a failed report does not invalidate the run itself.
 */
async function reportExecution(
  skill: Skill,
  result: { success: boolean; duration_ms: number },
): Promise<void> {
  const config = await readConfig();
  if (!config.api_url || !config.user_id) return;
  try {
    await fetch(`${config.api_url.replace(/\/$/, '')}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skill_id: skill.skill_id,
        user_id: config.user_id,
        success: result.success,
        duration_ms: result.duration_ms,
      }),
    });
  } catch (err) {
    console.warn('[flowmine] reportExecution failed:', err);
  }
}

// -----------------------------------------------------------------------------
// Popup message protocol
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender,
    sendResponse: (response: ExtensionResponse) => void,
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
          case 'list_active_skills': {
            sendResponse({
              kind: 'skills',
              skills: await fetchActiveSkills(),
            });
            return;
          }
          case 'run_skill': {
            const outcome = await executeSkill(message.skill);
            void reportExecution(message.skill, outcome);
            sendResponse({
              kind: 'run_result',
              success: outcome.success,
              duration_ms: outcome.duration_ms,
              ...(outcome.error ? { error: outcome.error } : {}),
            });
            return;
          }
          case 'execute_action': {
            // execute_action is meant for the content script. If a popup
            // ever sends it here by mistake, refuse politely instead of
            // half-handling it.
            sendResponse({
              kind: 'error',
              message: 'execute_action is handled in the content script',
            });
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
