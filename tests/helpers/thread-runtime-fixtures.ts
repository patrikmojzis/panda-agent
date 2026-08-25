import {randomUUID} from "node:crypto";

import type {Message} from "@earendil-works/pi-ai";

import type {JsonValue} from "../../src/lib/json.js";
import type {ThreadRunStatus} from "../../src/domain/threads/runtime/types.js";

interface FixturePool {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

export interface ThreadInputFixture {
  id?: string;
  threadId: string;
  source: string;
  deliveryMode?: "queue" | "wake";
  connectorKey?: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
  identityId?: string;
  message: Message;
  metadata?: JsonValue;
}

/** Seeds trusted fixture rows without asking pg-mem to emulate writable CTEs. */
export async function seedPendingThreadInput(
  pool: FixturePool,
  input: ThreadInputFixture,
): Promise<string> {
  const id = input.id ?? randomUUID();
  await pool.query(`
    INSERT INTO "runtime"."inputs" (
      id,
      thread_id,
      delivery_mode,
      source,
      connector_key,
      channel_id,
      external_message_id,
      actor_id,
      identity_id,
      created_at,
      metadata,
      message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10::jsonb, $11::jsonb)
  `, [
    id,
    input.threadId,
    input.deliveryMode ?? "wake",
    input.source,
    input.connectorKey ?? "",
    input.channelId ?? null,
    input.externalMessageId ?? null,
    input.actorId ?? null,
    input.identityId ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    JSON.stringify(input.message),
  ]);
  return id;
}

export async function seedAppliedThreadInput(
  pool: FixturePool,
  input: ThreadInputFixture,
): Promise<string> {
  const id = await seedPendingThreadInput(pool, input);
  await pool.query(`
    INSERT INTO "runtime"."messages" (
      id,
      input_id,
      thread_id,
      origin,
      source,
      channel_id,
      external_message_id,
      actor_id,
      identity_id,
      created_at,
      metadata,
      message
    )
    SELECT
      input.id,
      input.id,
      input.thread_id,
      'input',
      input.source,
      input.channel_id,
      input.external_message_id,
      input.actor_id,
      input.identity_id,
      input.created_at,
      input.metadata,
      input.message
    FROM "runtime"."inputs" AS input
    WHERE input.id = $1
  `, [id]);
  await pool.query(`
    UPDATE "runtime"."inputs"
    SET applied_at = NOW(), metadata = NULL, message = NULL
    WHERE id = $1
  `, [id]);
  return id;
}

export async function seedRuntimeMessage(
  pool: FixturePool,
  input: {
    id?: string;
    threadId: string;
    source: string;
    message: Message;
    metadata?: JsonValue;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await pool.query(`
    INSERT INTO "runtime"."messages" (
      id,
      thread_id,
      origin,
      source,
      created_at,
      metadata,
      message
    ) VALUES ($1, $2, 'runtime', $3, NOW(), $4::jsonb, $5::jsonb)
  `, [
    id,
    input.threadId,
    input.source,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    JSON.stringify(input.message),
  ]);
  return id;
}

/** Seeds historical run state without reviving the removed unfenced create-run API. */
export async function seedThreadRun(
  pool: FixturePool,
  input: {
    id?: string;
    threadId: string;
    status: ThreadRunStatus;
    error?: string;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  const running = input.status === "running";
  await pool.query(`
    INSERT INTO "runtime"."runs" (
      id,
      thread_id,
      owner_source,
      owner_key,
      owner_holder_id,
      status,
      started_at,
      finished_at,
      error
    ) VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      NOW(),
      CASE WHEN $6 = 'running' THEN NULL ELSE NOW() END,
      $7
    )
  `, [
    id,
    input.threadId,
    running ? "test" : null,
    running ? "fixture" : null,
    running ? "fixture" : null,
    input.status,
    input.error ?? null,
  ]);
  return id;
}
