/**
 * FlowMine — content script (in-page executor).
 *
 * Loaded into every http(s) page via the manifest content_scripts entry.
 * Stays passive until the background worker sends an `execute_action`
 * message; on receipt, dispatches to the matching DOM helper and replies
 * with an ActionResult.
 *
 * Navigation is intentionally NOT handled here — the background worker
 * uses chrome.tabs.update for that, because navigating away from the
 * current page would tear this script down mid-execution. Every other
 * SkillAction variant (click, fill, wait_for_selector, paste_clipboard,
 * scroll, wait) is implemented as a small async function that returns
 * { success, error?, effective_selector? }.
 *
 * The executor deliberately runs in the page's isolated world (Chrome's
 * default for content scripts), which gives us DOM access but keeps the
 * page's JavaScript globals out of our way.
 */

import type {
  ActionResult,
  ExtensionMessage,
  ExtensionResponse,
  SkillAction,
} from './types';

// -----------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------

/** Default poll timeout for wait_for_selector when ms is unspecified. */
const DEFAULT_SELECTOR_WAIT_MS = 5_000;

/** Polling cadence for wait_for_selector. Short enough to feel responsive
 *  on a heavy page, long enough to avoid burning CPU. */
const SELECTOR_POLL_MS = 100;

/** Wall-clock cap on any single action so a misbehaving page cannot lock
 *  the executor forever. */
const ACTION_HARD_CAP_MS = 30_000;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Promise that resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when `predicate()` returns truthy, or reject after `timeoutMs`. */
async function waitUntil<T>(
  predicate: () => T | null | undefined,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = predicate();
  while (!last) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await sleep(SELECTOR_POLL_MS);
    last = predicate();
  }
  return last;
}

/**
 * Find an element by selector. Returns null when nothing matches so the
 * caller can produce a useful error instead of throwing through a long stack.
 */
function queryElement(selector: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    // querySelector throws on a syntactically invalid selector; treat that
    // as "not found" from the executor's point of view.
    return null;
  }
}

/**
 * Fire the input + change events the way most React / Vue / Angular hosts
 * expect after a programmatic value mutation. Without these, frameworks
 * treat the field as unchanged and re-render the original value.
 */
function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

// -----------------------------------------------------------------------------
// Action implementations
// -----------------------------------------------------------------------------

async function doClick(selector: string): Promise<ActionResult> {
  const element = queryElement(selector);
  if (!element) {
    return { success: false, error: `No element matches ${selector}` };
  }
  element.scrollIntoView({ behavior: 'instant', block: 'center' });
  element.click();
  return { success: true, effective_selector: selector };
}

async function doFill(
  selector: string,
  value: string,
): Promise<ActionResult> {
  const element = queryElement(selector);
  if (!element) {
    return { success: false, error: `No element matches ${selector}` };
  }
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    !element.isContentEditable
  ) {
    return {
      success: false,
      error: `Element ${selector} is not a fillable field`,
    };
  }
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = value;
  } else {
    element.textContent = value;
  }
  dispatchInputEvents(element);
  return { success: true, effective_selector: selector };
}

async function doWaitForSelector(
  selector: string,
  ms?: number,
): Promise<ActionResult> {
  const budget = Math.min(ms ?? DEFAULT_SELECTOR_WAIT_MS, ACTION_HARD_CAP_MS);
  try {
    await waitUntil(() => queryElement(selector), budget);
    return { success: true, effective_selector: selector };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function doPasteClipboard(selector: string): Promise<ActionResult> {
  const element = queryElement(selector);
  if (!element) {
    return { success: false, error: `No element matches ${selector}` };
  }
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    !element.isContentEditable
  ) {
    return {
      success: false,
      error: `Element ${selector} is not a fillable field`,
    };
  }
  try {
    const text = await navigator.clipboard.readText();
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = text;
    } else {
      element.textContent = text;
    }
    dispatchInputEvents(element);
    return { success: true, effective_selector: selector };
  } catch (err) {
    return {
      success: false,
      error: `Clipboard read failed: ${(err as Error).message}`,
    };
  }
}

async function doScroll(
  selector: string | undefined,
  ms: number | undefined,
): Promise<ActionResult> {
  if (selector) {
    const element = queryElement(selector);
    if (!element) {
      return { success: false, error: `No element matches ${selector}` };
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    // No selector means scroll to bottom — a common requirement for "load
    // more" infinite scroll surfaces.
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'smooth',
    });
  }
  if (ms && ms > 0) await sleep(Math.min(ms, ACTION_HARD_CAP_MS));
  return { success: true, effective_selector: selector };
}

async function doWait(ms: number): Promise<ActionResult> {
  await sleep(Math.min(ms, ACTION_HARD_CAP_MS));
  return { success: true };
}

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

/**
 * Run a single SkillAction. Navigation is rejected up-front because the
 * background worker owns it; if a SkillSpec accidentally includes a
 * navigate inside a content-script dispatch, we surface a clear error
 * rather than silently no-op.
 */
async function executeAction(action: SkillAction): Promise<ActionResult> {
  switch (action.type) {
    case 'navigate':
      return {
        success: false,
        error: 'navigate must be dispatched by the background worker',
      };
    case 'click':
      return doClick(action.selector);
    case 'fill':
      return doFill(action.selector, action.value);
    case 'wait_for_selector':
      return doWaitForSelector(action.selector, action.ms);
    case 'paste_clipboard':
      return doPasteClipboard(action.selector);
    case 'scroll':
      return doScroll(action.selector, action.ms);
    case 'wait':
      return doWait(action.ms);
  }
}

// -----------------------------------------------------------------------------
// Message listener
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {
    if (message.kind !== 'execute_action') {
      // This script only handles execute_action; the background worker owns
      // every other message kind. Returning false tells Chrome we will not
      // respond, so the sender does not wait.
      return false;
    }
    void (async () => {
      try {
        const result = await executeAction(message.action);
        sendResponse({ kind: 'action_result', result });
      } catch (err) {
        sendResponse({
          kind: 'action_result',
          result: { success: false, error: (err as Error).message },
        });
      }
    })();
    // True tells Chrome we will respond asynchronously.
    return true;
  },
);

console.log('[flowmine] content executor ready');
