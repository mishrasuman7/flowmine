/**
 * FlowMine — popup script.
 *
 * Two-way bridge between the user and chrome.storage.local. The popup never
 * touches storage directly; every read or write goes through the
 * chrome.runtime message protocol implemented in background.ts, so the
 * source of truth for the storage schema lives in one place.
 */

import type { FlowMineConfig, FlushStatus } from './types';

// -----------------------------------------------------------------------------
// Message helpers
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

function sendMessage(message: PopupRequest): Promise<PopupResponse> {
  // chrome.runtime.sendMessage returns a Promise in MV3 when no callback is
  // passed. We wrap it so a missing service-worker (e.g. during a forced
  // reload from chrome://extensions) surfaces a recognisable error instead
  // of an uncaught rejection.
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: PopupResponse) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? 'sendMessage failed'));
        return;
      }
      resolve(response);
    });
  });
}

// -----------------------------------------------------------------------------
// DOM bindings
// -----------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

const teamInput = el<HTMLInputElement>('team-id');
const userInput = el<HTMLInputElement>('user-id');
const apiInput = el<HTMLInputElement>('api-url');
const saveButton = el<HTMLButtonElement>('save');
const flushButton = el<HTMLButtonElement>('flush');
const bufferedEl = el<HTMLElement>('buffered');
const lastFlushEl = el<HTMLElement>('last-flush');
const lastCountEl = el<HTMLElement>('last-count');
const lastErrorEl = el<HTMLElement>('last-error');

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function renderConfig(config: FlowMineConfig): void {
  teamInput.value = config.team_id;
  userInput.value = config.user_id;
  apiInput.value = config.api_url;
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  return date.toLocaleString();
}

function renderStatus(status: FlushStatus): void {
  bufferedEl.textContent = String(status.buffered_count);

  if (status.last_flush_at === null) {
    lastFlushEl.textContent = 'never';
    lastCountEl.textContent = '';
  } else {
    lastFlushEl.textContent = formatTimestamp(status.last_flush_at);
    lastCountEl.textContent =
      status.last_flush_count > 0
        ? ` (${status.last_flush_count} event${status.last_flush_count === 1 ? '' : 's'})`
        : '';
  }

  if (status.last_flush_error) {
    lastErrorEl.innerHTML = '';
    const label = document.createElement('strong');
    label.textContent = 'Error: ';
    const message = document.createElement('span');
    message.className = 'err';
    message.textContent = status.last_flush_error;
    lastErrorEl.appendChild(label);
    lastErrorEl.appendChild(message);
  } else {
    lastErrorEl.textContent = '';
  }
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

function validateConfigInputs(): FlowMineConfig | null {
  const team = teamInput.value.trim();
  const user = userInput.value.trim();
  const api = apiInput.value.trim();
  if (!team || !user || !api) return null;
  try {
    // Throws on malformed URL; we want a fast rejection before a save would
    // poison storage with an unusable api_url.
    new URL(api);
  } catch {
    return null;
  }
  return { team_id: team, user_id: user, api_url: api };
}

async function loadAll(): Promise<void> {
  const [configResp, statusResp] = await Promise.all([
    sendMessage({ kind: 'get_config' }),
    sendMessage({ kind: 'get_status' }),
  ]);
  if (configResp.kind === 'config') renderConfig(configResp.config);
  if (statusResp.kind === 'status') renderStatus(statusResp.status);
}

saveButton.addEventListener('click', async () => {
  const config = validateConfigInputs();
  if (!config) {
    saveButton.textContent = 'Check fields';
    setTimeout(() => (saveButton.textContent = 'Save'), 1500);
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = 'Saving...';
  try {
    const response = await sendMessage({ kind: 'set_config', config });
    saveButton.textContent = response.kind === 'ok' ? 'Saved' : 'Failed';
  } catch {
    saveButton.textContent = 'Failed';
  } finally {
    setTimeout(() => {
      saveButton.textContent = 'Save';
      saveButton.disabled = false;
    }, 1200);
  }
});

flushButton.addEventListener('click', async () => {
  flushButton.disabled = true;
  flushButton.textContent = 'Flushing...';
  try {
    await sendMessage({ kind: 'flush_now' });
    // Re-pull status so the UI reflects what just happened.
    const statusResp = await sendMessage({ kind: 'get_status' });
    if (statusResp.kind === 'status') renderStatus(statusResp.status);
  } finally {
    flushButton.textContent = 'Flush now';
    flushButton.disabled = false;
  }
});

// Initial paint.
void loadAll();
