/**
 * FlowMine — LLM wrapper (Google Gemini).
 *
 * Three distinct calls live behind this module, one per product use case:
 *
 *   1. generateSkill()    — Gemini 2.5 Flash, structured JSON output.
 *                           Takes a detected Pattern, returns a SkillSpec the
 *                           Chrome extension can execute step by step.
 *   2. interpretPattern() — Gemini 2.5 Flash, short JSON output.
 *                           Takes a Pattern, returns a human-readable
 *                           description plus an ROI estimate the dashboard
 *                           renders on each pattern card.
 *   3. fixSelector()      — Gemini 2.5 Flash, free-form text output.
 *                           Used during skill execution when a CSS selector
 *                           fails: given the broken selector and a DOM
 *                           snapshot, returns a corrected selector targeting
 *                           the semantically equivalent element.
 *
 * Why Gemini: Google AI Studio offers a generous free tier (no payment
 * method required for development quota), which removes the funding
 * barrier the project's original Anthropic + OpenAI stack imposed on
 * contributors outside payment-accessible regions.
 *
 * Model identifier is pinned in one constant below; bump it there if Google
 * ships a newer general-purpose Flash version.
 */

import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

import type {
  Pattern,
  PatternInterpretation,
  SkillSpec,
} from '@/lib/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Gemini 2.5 Flash — fast, JSON-mode capable, generous free tier. */
const MODEL_FLASH = 'gemini-2.5-flash';

/**
 * Output ceiling per call. SkillSpec JSON is comfortably under 2k tokens; the
 * interpretation is under 200. The bound exists to prevent runaway billing if
 * a prompt regression makes the model start rambling.
 */
const MAX_TOKENS_SKILL = 2048;
const MAX_TOKENS_INTERPRETATION = 512;
const MAX_TOKENS_SELECTOR = 256;

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

declare global {
  var __flowmineGemini: GoogleGenAI | undefined;
}

function getClient(): GoogleGenAI {
  if (!globalThis.__flowmineGemini) {
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GOOGLE_API_KEY missing: set it in web/.env.local before calling ' +
          'the LLM. Get a free key at https://aistudio.google.com/app/apikey.',
      );
    }
    globalThis.__flowmineGemini = new GoogleGenAI({ apiKey });
  }
  return globalThis.__flowmineGemini;
}

// -----------------------------------------------------------------------------
// Response parsing
// -----------------------------------------------------------------------------

/**
 * Pull the text content out of a generateContent response. The Gemini SDK
 * exposes a `text` getter on the response that flattens the first candidate's
 * concatenated text parts; we surface a clear error if that returns empty so
 * a silent prompt failure does not propagate undefined downstream.
 */
function extractText(response: GenerateContentResponse): string {
  const text = response.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Gemini returned no text content');
  }
  return text.trim();
}

/**
 * Parse a JSON payload out of Gemini's text response, tolerating accidental
 * code fences. The prompts ask for raw JSON, but defending against the
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
      `Failed to parse JSON from Gemini in ${context}: ${(err as Error).message}\n` +
        `Raw response: ${raw.slice(0, 400)}`,
    );
  }
}

// -----------------------------------------------------------------------------
// 1. Skill generation
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
  const response = await client.models.generateContent({
    model: MODEL_FLASH,
    contents: buildSkillUserPrompt(pattern),
    config: {
      systemInstruction: SKILL_SYSTEM_PROMPT,
      maxOutputTokens: MAX_TOKENS_SKILL,
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  });
  return parseJson<SkillSpec>(extractText(response), 'generateSkill');
}

// -----------------------------------------------------------------------------
// 2. Pattern interpretation
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
 * without waiting on the heavier skill generation step.
 */
export async function interpretPattern(
  pattern: Pattern,
): Promise<PatternInterpretation> {
  const client = getClient();
  const response = await client.models.generateContent({
    model: MODEL_FLASH,
    contents: buildInterpretationUserPrompt(pattern),
    config: {
      systemInstruction: INTERPRETATION_SYSTEM_PROMPT,
      maxOutputTokens: MAX_TOKENS_INTERPRETATION,
      responseMimeType: 'application/json',
      temperature: 0.3,
    },
  });
  return parseJson<PatternInterpretation>(
    extractText(response),
    'interpretPattern',
  );
}

// -----------------------------------------------------------------------------
// 3. Adaptive selector repair
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
 * Ask Gemini for a corrected selector when an executing skill step fails.
 * Returns null when the model reports no equivalent element exists, so the
 * executor can mark the skill failed and stop instead of looping forever.
 */
export async function fixSelector(
  input: FixSelectorInput,
): Promise<string | null> {
  const client = getClient();
  const response = await client.models.generateContent({
    model: MODEL_FLASH,
    contents: [
      `Intent: ${input.intent}`,
      `Broken selector: ${input.brokenSelector}`,
      'Current DOM snapshot:',
      input.domSnapshot,
    ].join('\n'),
    config: {
      systemInstruction: SELECTOR_SYSTEM_PROMPT,
      maxOutputTokens: MAX_TOKENS_SELECTOR,
      temperature: 0.2,
    },
  });

  const text = extractText(response);
  if (text === 'NONE' || text.length === 0) return null;
  return text;
}

// -----------------------------------------------------------------------------
// Exports for diagnostics
// -----------------------------------------------------------------------------

export { MODEL_FLASH };
