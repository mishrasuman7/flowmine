/**
 * FlowMine — OpenAI embeddings.
 *
 * Thin wrapper around `text-embedding-3-small` (1536 dimensions). The output
 * is fed into the `skills.embedding vector(1536)` column in Aurora so the
 * pattern-detection pipeline can ask pgvector "is there already a skill
 * semantically equivalent to this proposed one?" before spending Sonnet
 * tokens generating a new SkillSpec.
 *
 * Why this lives in its own module: we want a single place that fixes the
 * model name, the dimension count, and the Postgres-vector literal format —
 * those three are tightly coupled, and accidentally drifting any one of them
 * silently corrupts pgvector queries.
 */

import OpenAI from 'openai';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Locked to the model the Aurora vector column was sized for. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/** Must match `vector(1536)` in scripts/schema.sql exactly. */
export const EMBEDDING_DIMENSIONS = 1536;

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __flowmineOpenAI: OpenAI | undefined;
}

function getClient(): OpenAI {
  if (!globalThis.__flowmineOpenAI) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY missing: set it in web/.env.local before requesting ' +
          'embeddings.',
      );
    }
    globalThis.__flowmineOpenAI = new OpenAI({ apiKey });
  }
  return globalThis.__flowmineOpenAI;
}

// -----------------------------------------------------------------------------
// Embedding API
// -----------------------------------------------------------------------------

/**
 * Compute a single 1536-dim embedding for an arbitrary text input. We strip
 * surrounding whitespace and refuse empty strings up front so a typo upstream
 * cannot pollute the vector index with all-zero rows.
 */
export async function embed(text: string): Promise<number[]> {
  const cleaned = text.trim();
  if (cleaned.length === 0) {
    throw new Error('embed: cannot embed an empty string');
  }

  const client = getClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: cleaned,
  });

  const vector = response.data[0]?.embedding;
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embed: unexpected embedding shape (got ${vector?.length ?? 0}, ` +
        `expected ${EMBEDDING_DIMENSIONS})`,
    );
  }
  return vector;
}

/**
 * Compute embeddings for many texts in a single API call. OpenAI bills per
 * token regardless of batching, but batching cuts wall-clock time and TCP
 * overhead, which matters when the seed script needs to embed hundreds of
 * historical skills in one pass.
 */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const cleaned = texts.map((t) => t.trim());
  if (cleaned.some((t) => t.length === 0)) {
    throw new Error('embedMany: one or more inputs are empty after trimming');
  }

  const client = getClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: cleaned,
  });

  if (response.data.length !== cleaned.length) {
    throw new Error(
      `embedMany: response count mismatch (got ${response.data.length}, ` +
        `expected ${cleaned.length})`,
    );
  }

  // Sort by index because the OpenAI API does not guarantee response order
  // when the batch is large enough to be processed across shards.
  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  return sorted.map((row) => row.embedding);
}

// -----------------------------------------------------------------------------
// Postgres vector literal
// -----------------------------------------------------------------------------

/**
 * Serialise a JS number array into the pgvector text literal `[a,b,c,...]`.
 * Use this when binding an embedding as a parameterised query value:
 *
 *   await query('INSERT INTO skills (..., embedding) VALUES (..., $7::vector)',
 *               [..., toVectorLiteral(vec)]);
 *
 * pg's default array binder produces a PostgreSQL `ARRAY[...]` literal which
 * pgvector rejects; the bracket-comma form is the only format the extension
 * casts back into `vector` cleanly.
 */
export function toVectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `toVectorLiteral: expected ${EMBEDDING_DIMENSIONS} dims, ` +
        `got ${vector.length}`,
    );
  }
  return `[${vector.join(',')}]`;
}
