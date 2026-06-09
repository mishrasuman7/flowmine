/**
 * FlowMine — DynamoDB client + event writer.
 *
 * Provides a process-wide singleton DynamoDB Document Client (so we don't
 * recreate the HTTPS connection pool on every API request in Vercel's warm
 * function runtime) and a single high-level helper used by /api/events to
 * persist batches of browser events into the flowmine-events table.
 *
 * Table contract (see Section 5 of the project spec):
 *   PK  team_id    String
 *   SK  event_key  String   `${timestamp}#${user_id}#${seq}`
 *   GSI user_id-event_key-index (projection ALL)
 *   TTL created_at (Unix seconds, 90 days)
 *
 * All writes go through BatchWriteCommand, chunked at 25 items (the DynamoDB
 * hard limit per BatchWrite request).
 */

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { BrowserEvent, StoredBrowserEvent } from '@/lib/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const TABLE_NAME = process.env.DYNAMODB_EVENTS_TABLE ?? 'flowmine-events';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

/** DynamoDB BatchWriteItem hard limit. */
const BATCH_SIZE = 25;

/** Retention window mirrored in the table's TTL attribute. */
const TTL_DAYS = 90;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// -----------------------------------------------------------------------------
// Singleton client
// -----------------------------------------------------------------------------

/**
 * Build the low-level config once. We only pass explicit credentials when both
 * env vars are present so the SDK can fall back to IAM roles in production
 * (Lambda, Vercel OIDC, etc.) without us hardcoding a credential path.
 */
function buildClientConfig(): DynamoDBClientConfig {
  const config: DynamoDBClientConfig = { region: REGION };
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  return config;
}

/**
 * Module-scoped singleton. Next.js may hot-reload this module in dev, which
 * would otherwise leak connection pools; storing the instance on globalThis
 * survives that reload cleanly.
 */
declare global {
  var __flowmineDynamoClient: DynamoDBDocumentClient | undefined;
}

function getClient(): DynamoDBDocumentClient {
  if (!globalThis.__flowmineDynamoClient) {
    const raw = new DynamoDBClient(buildClientConfig());
    globalThis.__flowmineDynamoClient = DynamoDBDocumentClient.from(raw, {
      marshallOptions: {
        // Browser events sometimes carry empty strings (e.g. session_id on
        // the very first event in a session); preserving them avoids type
        // surprises downstream.
        convertEmptyValues: false,
        removeUndefinedValues: true,
        convertClassInstanceToMap: false,
      },
    });
  }
  return globalThis.__flowmineDynamoClient;
}

// -----------------------------------------------------------------------------
// Event-key construction
// -----------------------------------------------------------------------------

/**
 * Build the composite sort key for a browser event. The `seq` suffix
 * disambiguates events that share the same millisecond timestamp inside a
 * single batch (which happens whenever the extension flushes a burst).
 */
export function buildEventKey(
  event: BrowserEvent,
  seq: number,
): string {
  return `${event.timestamp}#${event.user_id}#${seq}`;
}

/**
 * Transform a wire-shape BrowserEvent into the persisted DynamoDB row,
 * attaching the composite sort key and the TTL attribute (Unix seconds).
 */
function toStoredEvent(event: BrowserEvent, seq: number): StoredBrowserEvent {
  return {
    ...event,
    event_key: buildEventKey(event, seq),
    // DynamoDB TTL is expressed in seconds; the wire timestamp is in
    // milliseconds. Future-date the TTL by the retention window so the row
    // becomes eligible for expiry TTL_DAYS after capture, not after write.
    created_at: Math.floor(event.timestamp / 1000) + TTL_SECONDS,
  };
}

// -----------------------------------------------------------------------------
// Batch writer
// -----------------------------------------------------------------------------

/**
 * Split an array into fixed-size chunks. Pulled out as a helper so the batch
 * writer reads top-to-bottom without an inline slice loop.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Persist a batch of browser events. Returns the number of items successfully
 * written, which is what /api/events sends back to the extension as an
 * acknowledgement so the extension can drop them from its local queue.
 *
 * Handles the DynamoDB BatchWriteItem semantics carefully:
 *   - chunks the input into 25-item requests;
 *   - retries any `UnprocessedItems` returned by AWS up to three times with
 *     a small linear backoff (Dynamo recommends caller-side retry rather than
 *     silently dropping rows);
 *   - throws on persistent failure so the API route can return 5xx and the
 *     extension can re-queue the batch.
 */
export async function batchWriteEvents(
  events: BrowserEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const client = getClient();
  const stored = events.map((event, index) => toStoredEvent(event, index));
  let written = 0;

  for (const group of chunk(stored, BATCH_SIZE)) {
    let pending = group.map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;

    while (pending.length > 0) {
      const response = await client.send(
        new BatchWriteCommand({
          RequestItems: { [TABLE_NAME]: pending },
        }),
      );

      const unprocessed = response.UnprocessedItems?.[TABLE_NAME] ?? [];
      written += pending.length - unprocessed.length;

      if (unprocessed.length === 0) break;

      attempt += 1;
      if (attempt >= 3) {
        throw new Error(
          `batchWriteEvents: ${unprocessed.length} items unprocessed ` +
            `after ${attempt} attempts (table=${TABLE_NAME})`,
        );
      }

      // Narrow the unprocessed requests back into the shape BatchWriteCommand
      // expects on the next iteration. The SDK types are intentionally loose
      // here because the same array can carry mixed PutRequest/DeleteRequest
      // entries; we only ever issue PutRequests.
      pending = unprocessed.flatMap((req) =>
        req.PutRequest?.Item
          ? [{ PutRequest: { Item: req.PutRequest.Item as StoredBrowserEvent } }]
          : [],
      );

      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }

  return written;
}

// -----------------------------------------------------------------------------
// Exports for tests and route handlers
// -----------------------------------------------------------------------------

export { TABLE_NAME as EVENTS_TABLE_NAME, getClient as getDynamoClient };
