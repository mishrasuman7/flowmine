/**
 * FlowMine — Gemini embeddings.
 *
 * Thin wrapper around `gemini-embedding-001` configured to emit 1536-dim
 * vectors. The output is fed into the `skills.embedding vector(1536)` column
 * in Aurora so the pattern-detection pipeline can ask pgvector "is there
 * already a skill semantically equivalent to this proposed one?" before
 * spending Flash tokens generating a new SkillSpec.
 *
 * Why this lives in its own module: we want a single place that fixes the
 * model name, the dimension count, and the Postgres-vector literal format —
 * those three are tightly coupled, and accidentally drifting any one of them
 * silently corrupts pgvector queries.
 */

import { GoogleGenAI } from '@google/genai';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Locked to the model the Aurora vector column was sized for. */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Must match `vector(1536)` in scripts/schema.sql exactly. Gemini's
 * embedding endpoint accepts an outputDimensionality config that downsizes
 * the default 3072-dim representation into 1536, 768, or 256 dimensions
 * while preserving the semantic ranking.
 */
export const EMBEDDING_DIMENSIONS = 1536;

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

declare global {
  var __flowmineEmbeddingClient: GoogleGenAI | undefined;
}

function getClient(): GoogleGenAI {
  if (!globalThis.__flowmineEmbeddingClient) {
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GOOGLE_API_KEY missing: set it in web/.env.local before requesting ' +
          'embeddings. Get a free key at https://aistudio.google.com/app/apikey.',
      );
    }
    globalThis.__flowmineEmbeddingClient = new GoogleGenAI({ apiKey });
  }
  return globalThis.__flowmineEmbeddingClient;
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
  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: cleaned,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });

  const vector = response.embeddings?.[0]?.values;
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embed: unexpected embedding shape (got ${vector?.length ?? 0}, ` +
        `expected ${EMBEDDING_DIMENSIONS})`,
    );
  }
  return vector;
}

/**
 * Compute embeddings for many texts in a single API call. Gemini bills per
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
  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: cleaned,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });

  const embeddings = response.embeddings ?? [];
  if (embeddings.length !== cleaned.length) {
    throw new Error(
      `embedMany: response count mismatch (got ${embeddings.length}, ` +
        `expected ${cleaned.length})`,
    );
  }

  return embeddings.map((row, idx) => {
    const values = row.values;
    if (!values || values.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedMany: row ${idx} has unexpected dimension ` +
          `(${values?.length ?? 0}, expected ${EMBEDDING_DIMENSIONS})`,
      );
    }
    return values;
  });
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
