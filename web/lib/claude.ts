/**
 * FlowMine — Anthropic Claude wrapper.
 *
 * Three distinct calls live behind this module, one per product use case:
 *
 *   1. generateSkill()    — Claude Sonnet, structured JSON output.
 *                           Takes a detected Pattern, returns a SkillSpec the
 *                           Chrome extension can execute step by step.
 *   2. interpretPattern() — Claude Haiku, short JSON output.
 *                           Takes a Pattern, returns a human-readable
 *                           description plus an ROI estimate the dashboard
 *                           renders on each pattern card.
 *   3. fixSelector()      — Claude Sonnet, free-form text output.
 *                           Used during skill execution when a CSS selector
 *                           fails: given the broken selector and a DOM
 *                           snapshot, returns a corrected selector targeting
 *                           the semantically equivalent element.
 *
 * Model identifiers are pinned to the canonical aliases listed in the project
 * spec. If Anthropic ships new versions, bump them here and only here.
 */

import Anthropic from '@anthropic-ai/sdk';

import type {
  Pattern,
  PatternInterpretation,
  SkillSpec,
} from '@/lib/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Sonnet handles structured generation and DOM repair (higher quality, slower). */
const MODEL_SONNET = 'claude-sonnet-4-5';

/** Haiku handles cheap one-shot summarisation (lower cost, faster). */
const MODEL_HAIKU = 'claude-haiku-4-5';

/**
 * Output ceiling per call. SkillSpec JSON is comfortably under 2k tokens; the
 * Haiku interpretation is under 200. The bound exists to prevent runaway
 * billing if a prompt regression makes the model start rambling.
 */
const MAX_TOKENS_SKILL = 2048;
const MAX_TOKENS_INTERPRETATION = 512;
const MAX_TOKENS_SELECTOR = 256;

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __flowmineAnthropic: Anthropic | undefined;
}

function getClient(): Anthropic {
  if (!globalThis.__flowmineAnthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY missing: set it in web/.env.local before calling ' +
          'Claude.',
      );
    }
    globalThis.__flowmineAnthropic = new Anthropic({ apiKey });
  }
  return globalThis.__flowmineAnthropic;
}

// -----------------------------------------------------------------------------
// Response parsing
// -----------------------------------------------------------------------------

/**
 * Pull the first text block out of a Messages API response. The SDK returns a
 * union of content blocks (text, tool_use, image, ...); we only ever ask the
 * model for text in this file, so anything else is a bug worth surfacing.
 */
function extractText(response: Anthropic.Message): string {
  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new Error(
      `Claude returned unexpected content block: ${block?.type ?? 'none'}`,
    );
  }
  return block.text.trim();
}

/**
 * Parse a JSON payload out of Claude's text response, tolerating accidental
 * code fences. The system prompts forbid preambles, but defending against the
 * occasional ```json wrapper is cheap insurance against a 100%-reliable model
 * having a 0.1% bad day.
 */
function parseJson<T>(raw: string, context: string): T {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from Claude in ${context}: ${(err as Error).message}\n` +
        `Raw response: ${raw.slice(0, 400)}`,
    );
  }
}

// -----------------------------------------------------------------------------
// 1. Skill generation (Sonnet)
// -----------------------------------------------------------------------------

const SKILL_SYSTEM_PROMPT =
  'You are an automation expert. Given a browser workflow pattern, output ' +
  'ONLY valid JSON matching the schema. No preamble, no explanation, no ' +
  'markdown fences.';

/**
 * Build the user-side prompt that describes the detected workflow. Keeping
 * the schema inline keeps prompt and TypeScript shape in lockstep — if we
 * add a new SkillAction variant in types.ts we have to update it here too.
 */
function buildSkillUserPrompt(pattern: Pattern): string {
  return [
    'Detected workflow pattern:',
    `- domains: ${JSON.stringify(pattern.sequence)}`,
    `- frequency: ${pattern.frequency} occurrences across the team`,
    `- score: ${pattern.score}`,
    pattern.est_hours_monthly !== null
      ? `- estimated monthly hours spent: ${pattern.est_hours_monthly}`
      : null,
    '',
    'Produce a SkillSpec JSON object matching exactly this TypeScript shape:',
    '',
    'interface SkillSpec {',
    '  name: string;',
    '  description: string;',
    '  trigger: { event_sequence: string[]; time_window_ms: number; };',
    '  actions: Array<',
    "    | { type: 'navigate'; url: string }",
    "    | { type: 'click'; selector: string }",
    "    | { type: 'fill'; selector: string; value: string }",
    "    | { type: 'wait_for_selector'; selector: string; ms?: number }",
    "    | { type: 'paste_clipboard'; selector: string }",
    "    | { type: 'scroll'; selector?: string; ms?: number }",
    "    | { type: 'wait'; ms: number }",
    '  >;',
    '  estimated_duration_ms: number;',
    '  estimated_human_time_ms: number;',
    '}',
    '',
    'Use realistic selectors and URLs based on the domains involved.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Generate a SkillSpec for a detected pattern. Throws on malformed JSON so
 * /api/generate-skill can return 5xx and the dashboard surfaces the failure
 * instead of silently writing a broken skill row.
 */
export async function generateSkill(pattern: Pattern): Promise<SkillSpec> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: MAX_TOKENS_SKILL,
    system: SKILL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildSkillUserPrompt(pattern) }],
  });
  return parseJson<SkillSpec>(extractText(response), 'generateSkill');
}

// -----------------------------------------------------------------------------
// 2. Pattern interpretation (Haiku)
// -----------------------------------------------------------------------------

const INTERPRETATION_SYSTEM_PROMPT =
  'You analyse browser workflow patterns for a B2B operations dashboard. ' +
  'Reply ONLY with valid JSON of the form ' +
  '{ "description": string, "est_hours_saved_monthly": number }. ' +
  'No preamble, no markdown.';

function buildInterpretationUserPrompt(pattern: Pattern): string {
  return [
    'Pattern domains in order: ' + JSON.stringify(pattern.sequence),
    `Total occurrences across the team: ${pattern.frequency}`,
    `Detection score: ${pattern.score}`,
    '',
    'Write a 1-2 sentence plain-English description aimed at a head of ' +
      'operations. Then estimate the team-wide hours saved per month if this ' +
      'workflow were automated, as a positive number.',
  ].join('\n');
}

/**
 * Cheap, frequent call: runs against every newly detected pattern so the
 * dashboard can render a card with a sentence and a hours-saved number
 * without waiting on the heavier Sonnet skill generation step.
 */
export async function interpretPattern(
  pattern: Pattern,
): Promise<PatternInterpretation> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL_HAIKU,
    max_tokens: MAX_TOKENS_INTERPRETATION,
    system: INTERPRETATION_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildInterpretationUserPrompt(pattern) },
    ],
  });
  return parseJson<PatternInterpretation>(
    extractText(response),
    'interpretPattern',
  );
}

// -----------------------------------------------------------------------------
// 3. Adaptive selector repair (Sonnet)
// -----------------------------------------------------------------------------

const SELECTOR_SYSTEM_PROMPT =
  'You repair broken CSS selectors during automated browser workflows. The ' +
  'user gives you the original selector and a snapshot of the current DOM. ' +
  'Reply with ONLY the corrected CSS selector as a single line of text. No ' +
  'quotes, no markdown, no explanation. If no semantically equivalent ' +
  'element exists, reply with the literal string NONE.';

interface FixSelectorInput {
  /** The selector that just failed to match. */
  brokenSelector: string;
  /** Plain-English description of what the action was trying to accomplish
   *  (e.g. "click the Save button on the lead form"). */
  intent: string;
  /** Outer HTML snapshot of the current page, truncated to keep prompt size
   *  bounded. */
  domSnapshot: string;
}

/**
 * Ask Sonnet for a corrected selector when an executing skill step fails.
 * Returns null when the model reports no equivalent element exists, so the
 * executor can mark the skill failed and stop instead of looping forever.
 */
export async function fixSelector(
  input: FixSelectorInput,
): Promise<string | null> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: MAX_TOKENS_SELECTOR,
    system: SELECTOR_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `Intent: ${input.intent}`,
          `Broken selector: ${input.brokenSelector}`,
          'Current DOM snapshot:',
          input.domSnapshot,
        ].join('\n'),
      },
    ],
  });

  const text = extractText(response);
  if (text === 'NONE' || text.length === 0) return null;
  return text;
}

// -----------------------------------------------------------------------------
// Exports for diagnostics
// -----------------------------------------------------------------------------

export { MODEL_SONNET, MODEL_HAIKU };
