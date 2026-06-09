/**
 * FlowMine extension — local type contracts.
 *
 * Mirrors the BrowserEvent / SkillAction / SkillSpec / Skill shapes from
 * web/lib/types.ts so the extension and the server agree on every wire
 * format they share. We duplicate rather than import across the monorepo
 * because the extension is a fully separate build (no bundler path
 * mapping into web/) and one tiny file is cheaper than shipping a shared
 * package.
 */

// =============================================================================
// Browser events (capture side)
// =============================================================================

export type BrowserEventType = 'navigate' | 'tab_activate' | 'tab_close';

export interface BrowserEvent {
  team_id: string;
  user_id: string;
  domain: string;
  event_type: BrowserEventType;
  tab_id: string;
  session_id: string;
  timestamp: number;
}

// =============================================================================
// Configuration + diagnostics
// =============================================================================

/** Persisted configuration read from chrome.storage.local. */
export interface FlowMineConfig {
  team_id: string;
  user_id: string;
  api_url: string;
}

/** Diagnostic snapshot the popup reads to show last-flush status. */
export interface FlushStatus {
  last_flush_at: number | null;
  last_flush_count: number;
  last_flush_error: string | null;
  buffered_count: number;
}

// =============================================================================
// Skill execution (execution side)
// =============================================================================

/**
 * Discriminated union of the action steps Claude is allowed to emit in a
 * SkillSpec. The executor narrows on `type` before dispatching to the
 * corresponding DOM helper.
 */
export type SkillAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'wait_for_selector'; selector: string; ms?: number }
  | { type: 'paste_clipboard'; selector: string }
  | { type: 'scroll'; selector?: string; ms?: number }
  | { type: 'wait'; ms: number };

export interface SkillSpec {
  name: string;
  description: string;
  trigger: {
    event_sequence: string[];
    time_window_ms: number;
  };
  actions: SkillAction[];
  estimated_duration_ms: number;
  estimated_human_time_ms: number;
}

export type SkillStatus =
  | 'draft'
  | 'active'
  | 'executing'
  | 'paused'
  | 'retired';

export interface Skill {
  skill_id: string;
  team_id: string;
  pattern_id: string | null;
  name: string;
  description: string | null;
  action_sequence: SkillSpec;
  status: SkillStatus;
  success_count: number;
  failure_count: number;
  created_at: string;
}

/**
 * Result of running a single action in the page context. The DOM-side
 * helpers return this shape; the background worker aggregates them into a
 * per-skill execution record.
 */
export interface ActionResult {
  success: boolean;
  /** Human-readable error reason; only populated on failure. */
  error?: string;
  /** Optional selector that the executor ended up using — useful for
   *  surfacing adaptive selector repair results to the dashboard later. */
  effective_selector?: string;
}

/**
 * Message kinds exchanged between popup, background worker, and content
 * script. Each is discriminated by `kind` so the listener can narrow safely.
 */
export type ExtensionMessage =
  | { kind: 'get_config' }
  | { kind: 'set_config'; config: FlowMineConfig }
  | { kind: 'get_status' }
  | { kind: 'flush_now' }
  | { kind: 'list_active_skills' }
  | { kind: 'run_skill'; skill: Skill }
  | { kind: 'execute_action'; action: SkillAction };

export type ExtensionResponse =
  | { kind: 'config'; config: FlowMineConfig }
  | { kind: 'status'; status: FlushStatus }
  | { kind: 'ok' }
  | { kind: 'skills'; skills: Skill[] }
  | { kind: 'run_result'; success: boolean; duration_ms: number; error?: string }
  | { kind: 'action_result'; result: ActionResult }
  | { kind: 'error'; message: string };
