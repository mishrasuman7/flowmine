/**
 * FlowMine — popup script.
 *
 * Two-way bridge between the user and chrome.storage.local. The popup never
 * touches storage directly; every read or write goes through the
 * chrome.runtime message protocol implemented in background.ts, so the
 * source of truth for the storage schema lives in one place.
 *
 * The popup surfaces three sections, top to bottom:
 *   1. Configuration — team_id, user_id, api_url inputs + Save.
 *   2. Capture status — buffered event count, last flush time + diagnostics,
 *      Flush now button.
 *   3. Active skills — list pulled from /api/skills with a one-click Run
 *      button per skill that dispatches the SkillSpec to the background
 *      worker for execution on the current tab.
 */

import type {
  ExtensionMessage,
  ExtensionResponse,
  FlowMineConfig,
  FlushStatus,
  Skill,
} from './types';

// -----------------------------------------------------------------------------
// Message helpers
// -----------------------------------------------------------------------------

function sendMessage(
  message: ExtensionMessage,
): Promise<ExtensionResponse> {
  // chrome.runtime.sendMessage returns a Promise in MV3 when no callback is
  // passed. We wrap it so a missing service-worker (e.g. during a forced
  // reload from chrome://extensions) surfaces a recognisable error instead
  // of an uncaught rejection.
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: ExtensionResponse) => {
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
const skillsCountEl = el<HTMLElement>('skills-count');
const skillListEl = el<HTMLUListElement>('skill-list');
const skillEmptyEl = el<HTMLElement>('skill-empty');
const skillResultEl = el<HTMLElement>('skill-result');

// -----------------------------------------------------------------------------
// Rendering — configuration + capture status
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
// Rendering — active skills
// -----------------------------------------------------------------------------

function renderSkillResult(
  message: string,
  tone: 'ok' | 'err',
): void {
  skillResultEl.innerHTML = '';
  const span = document.createElement('span');
  span.className = tone;
  span.textContent = message;
  skillResultEl.appendChild(span);
}

function clearSkillResult(): void {
  skillResultEl.textContent = '';
}

function renderSkills(skills: Skill[]): void {
  skillsCountEl.textContent = String(skills.length);
  skillListEl.innerHTML = '';
  if (skills.length === 0) {
    skillEmptyEl.hidden = false;
    return;
  }
  skillEmptyEl.hidden = true;
  for (const skill of skills) {
    const item = document.createElement('li');
    item.className = 'skill-item';

    const name = document.createElement('span');
    name.className = 'skill-name';
    name.textContent = skill.name;
    name.title = skill.description ?? skill.name;

    const steps = document.createElement('span');
    steps.className = 'skill-steps';
    const actionCount = skill.action_sequence?.actions?.length ?? 0;
    steps.textContent = `${actionCount} step${actionCount === 1 ? '' : 's'}`;

    const run = document.createElement('button');
    run.className = 'skill-run';
    run.type = 'button';
    run.textContent = 'Run';
    run.addEventListener('click', () => {
      void runSkill(skill, run);
    });

    item.append(name, steps, run);
    skillListEl.appendChild(item);
  }
}

async function loadSkills(): Promise<void> {
  try {
    const response = await sendMessage({ kind: 'list_active_skills' });
    if (response.kind === 'skills') {
      renderSkills(response.skills);
    }
  } catch (err) {
    renderSkillResult(`Could not load skills: ${(err as Error).message}`, 'err');
  }
}

async function runSkill(skill: Skill, trigger: HTMLButtonElement): Promise<void> {
  // Disable every Run button while one skill is executing so the user
  // cannot fire two runs on the same tab. The runtime guards against this
  // server-side, but stopping it client-side keeps the UX honest.
  const allButtons = Array.from(
    skillListEl.querySelectorAll<HTMLButtonElement>('button.skill-run'),
  );
  allButtons.forEach((button) => (button.disabled = true));
  trigger.textContent = 'Running…';
  clearSkillResult();

  try {
    const response = await sendMessage({ kind: 'run_skill', skill });
    if (response.kind === 'run_result') {
      const seconds = (response.duration_ms / 1000).toFixed(1);
      if (response.success) {
        renderSkillResult(`${skill.name} ran in ${seconds}s`, 'ok');
      } else {
        renderSkillResult(
          `${skill.name} failed after ${seconds}s — ${response.error ?? 'unknown error'}`,
          'err',
        );
      }
    } else if (response.kind === 'error') {
      renderSkillResult(`Error: ${response.message}`, 'err');
    }
  } catch (err) {
    renderSkillResult((err as Error).message, 'err');
  } finally {
    trigger.textContent = 'Run';
    allButtons.forEach((button) => (button.disabled = false));
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
  await loadSkills();
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
    // The skills list is scoped to the saved team_id; reload after a save
    // so the popup reflects the new tenancy without a manual refresh.
    if (response.kind === 'ok') await loadSkills();
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
