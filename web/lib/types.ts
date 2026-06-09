/**
 * FlowMine — Shared TypeScript types.
 *
 * One file, no `any`. These types describe the on-the-wire and on-disk shapes
 * exchanged between the Chrome extension, Next.js API routes, the DynamoDB
 * event store, and the Aurora relational store. Anywhere a route, helper, or
 * component touches one of these shapes, it should import from here so the
 * vocabulary stays consistent end to end.
 */

// =============================================================================
// Tenancy
// =============================================================================

export type TeamPlan = 'free' | 'pro' | 'enterprise';
export type UserRole = 'admin' | 'member';

export interface Team {
  team_id: string;
  name: string;
  plan: TeamPlan;
  seat_count: number;
  created_at: string;
}

export interface User {
  user_id: string;
  team_id: string;
  email: string;
  role: UserRole;
  created_at: string;
}

// =============================================================================
// Browser events — written by the Chrome extension, stored in DynamoDB
// =============================================================================

/**
 * Discriminator for raw browser events. The extension only captures metadata,
 * never page content, so this small enum covers everything we observe.
 */
export type BrowserEventType = 'navigate' | 'tab_activate' | 'tab_close';

/**
 * Per-event payload sent in batches from the extension to /api/events. Field
 * names match the DynamoDB attribute names exactly so the API route can write
 * the object through with minimal transformation.
 *
 * - `team_id` is the partition key.
 * - `event_key` (built by the API route as `${timestamp}#${user_id}#${seq}`)
 *   is the sort key.
 * - `session_id` is reset by the extension after a 5-minute gap of inactivity.
 */
export interface BrowserEvent {
  team_id: string;
  user_id: string;
  domain: string;
  event_type: BrowserEventType;
  tab_id: string;
  session_id: string;
  timestamp: number;
}

/**
 * Persisted shape in DynamoDB. Differs from the wire shape by the addition of
 * the sort key (`event_key`) and the TTL attribute (`created_at` in seconds).
 */
export interface StoredBrowserEvent extends BrowserEvent {
  event_key: string;
  created_at: number;
}

// =============================================================================
// Detected patterns
// =============================================================================

export type PatternStatus = 'detected' | 'reviewed' | 'discarded';

/**
 * A repeating multi-step workflow detected by the pattern-detection Lambda.
 * `sequence` is the ordered list of domains that make up one occurrence of the
 * pattern (e.g. ["salesforce.com", "docs.google.com", "gmail.com"]).
 */
export interface Pattern {
  pattern_id: string;
  team_id: string;
  sequence: string[];
  frequency: number;
  score: number;
  est_hours_monthly: number | null;
  status: PatternStatus;
  detected_at: string;
}

/**
 * API response shape for GET /api/patterns. `user_count` is joined in from the
 * pattern_users table so the dashboard can render team-adoption metrics
 * without a second round-trip.
 */
export interface PatternWithUsers extends Pattern {
  user_count: number;
}

/**
 * Row in the pattern_users join table — how many times a given user has been
 * observed performing a given pattern.
 */
export interface PatternUser {
  pattern_id: string;
  user_id: string;
  occurrence_count: number;
}

// =============================================================================
// AI-generated skills
// =============================================================================

/**
 * Lifecycle of a generated skill. `executing` is transient — the dashboard
 * shows it briefly while a run is in flight, and the row reverts to `active`
 * when the run finishes.
 */
export type SkillStatus =
  | 'draft'
  | 'active'
  | 'executing'
  | 'paused'
  | 'retired';

/**
 * Discriminated union of the action steps Claude is allowed to emit in a
 * SkillSpec. Each step type names exactly the fields it needs; the executor
 * narrows on `type` before dispatching to the corresponding DOM helper.
 */
export type SkillAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'wait_for_selector'; selector: string; ms?: number }
  | { type: 'paste_clipboard'; selector: string }
  | { type: 'scroll'; selector?: string; ms?: number }
  | { type: 'wait'; ms: number };

/**
 * Structured output of the Claude Sonnet skill-generation prompt. This is what
 * the extension executes step by step.
 */
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

/**
 * Persisted skill row in Aurora. `embedding` is the OpenAI
 * text-embedding-3-small vector and is omitted from API responses by default
 * so the dashboard payload stays small.
 */
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
 * Skill row plus the raw embedding vector. Only used by server-side similarity
 * search; never sent to the client.
 */
export interface SkillWithEmbedding extends Skill {
  embedding: number[];
}

/**
 * Output of the Claude Haiku pattern-interpretation prompt — a short natural
 * language description plus a quick ROI estimate that the dashboard renders
 * on each pattern card before the user decides to generate a skill.
 */
export interface PatternInterpretation {
  description: string;
  est_hours_saved_monthly: number;
}

// =============================================================================
// Telemetry
// =============================================================================

export interface SkillExecution {
  execution_id: string;
  skill_id: string;
  user_id: string;
  success: boolean;
  duration_ms: number | null;
  executed_at: string;
}

// =============================================================================
// API payloads
// =============================================================================

/** POST /api/events */
export interface PostEventsRequest {
  events: BrowserEvent[];
}
export interface PostEventsResponse {
  success: true;
  written: number;
}

/** GET /api/patterns */
export interface GetPatternsResponse {
  patterns: PatternWithUsers[];
}

/** POST /api/generate-skill */
export interface GenerateSkillRequest {
  pattern_id: string;
  pattern: Pattern;
}
export interface GenerateSkillResponse {
  skill: Skill;
}

/** GET /api/skills */
export interface GetSkillsResponse {
  skills: Skill[];
}

/** PATCH /api/skills */
export interface PatchSkillRequest {
  skill_id: string;
  status: SkillStatus;
}
export interface PatchSkillResponse {
  skill: Skill;
}

/** POST /api/execute */
export interface PostExecuteRequest {
  skill_id: string;
  user_id: string;
  success: boolean;
  duration_ms: number;
}
export interface PostExecuteResponse {
  execution: SkillExecution;
}

// =============================================================================
// Pusher realtime channel events
// =============================================================================

/** Channel name builder so the team scoping stays consistent across files. */
export const teamChannel = (teamId: string): string => `team-${teamId}`;

export type PusherEvent =
  | { name: 'new-pattern'; payload: PatternWithUsers }
  | { name: 'skill-activated'; payload: Skill }
  | { name: 'execution-complete'; payload: SkillExecution };
