import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";

import {resolveModelSelector} from "../../kernel/models/model-selector.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {requireBoolean} from "../../lib/booleans.js";
import {readOptionalJsonValue, stringifyOptionalJsonValue, type JsonValue} from "../../lib/json.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import {resolveSessionRef} from "./refs.js";
import {buildSessionTableNames, type SessionTableNames} from "./postgres-shared.js";
import {ensurePostgresSessionSchema} from "./postgres-schema.js";
import type {SessionStore} from "./store.js";
import {calculateSessionTodoItemsHash, normalizeSessionTodoItems} from "./todos.js";
import type {ReplaceSessionTodoInput, SessionTodoRecord} from "./todos.js";
import {SESSION_BRIEFING_PROMPT_SLUG, normalizeSessionAlias, normalizeSessionPromptSlug} from "./types.js";
import type {
  ClaimSessionHeartbeatInput,
  CreateSessionInput,
  DeleteSessionPromptInput,
  ListDueSessionHeartbeatsInput,
  RecordSessionHeartbeatResultInput,
  ResolveSessionRefInput,
  SessionHeartbeatRecord,
  SessionPromptRecord,
  SessionPromptSlug,
  SessionRecord,
  SessionRuntimeConfigRecord,
  SetSessionPromptInput,
  UpdateSessionCurrentThreadInput,
  UpdateSessionHeartbeatConfigInput,
  UpdateSessionLabelInput,
  UpdateSessionRuntimeConfigInput,
} from "./types.js";

export interface PostgresSessionStoreOptions {
  pool: PgPoolLike;
}

function requireSessionString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Session ${field} must not be empty.`);
}

function optionalSessionString(field: string, value: unknown): string | undefined {
  return optionalNonEmptyString(value, `Session ${field} must not be empty.`);
}

function normalizeOptionalSessionAlias(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeSessionAlias(value);
}

function normalizeOptionalDisplayName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Session display name must not be empty.");
  }

  return trimmed;
}

function parseSessionKind(value: unknown): SessionRecord["kind"] {
  if (value === "main" || value === "branch" || value === "worker") {
    return value;
  }

  throw new Error(`Unsupported session kind ${String(value)}.`);
}

function parseHeartbeatEveryMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("Session heartbeat interval must be a positive integer.");
  }

  return value;
}

function requireHeartbeatEveryMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Session heartbeat interval must be a positive integer.");
  }

  return value;
}

function parseSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: requireSessionString("id", row.id),
    agentKey: requireSessionString("agent key", row.agent_key),
    kind: parseSessionKind(row.kind),
    currentThreadId: requireSessionString("current thread id", row.current_thread_id),
    createdByIdentityId: optionalSessionString("created identity id", row.created_by_identity_id),
    alias: optionalSessionString("alias", row.alias),
    displayName: optionalSessionString("display name", row.display_name),
    metadata: readOptionalJsonValue(row.metadata, "Session metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Session created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session updated_at must be a valid timestamp."),
  };
}

function parseHeartbeatRow(row: Record<string, unknown>): SessionHeartbeatRecord {
  const everyMinutes = parseHeartbeatEveryMinutes(row.every_minutes);
  return {
    sessionId: requireSessionString("id", row.session_id),
    enabled: requireBoolean(row.enabled, "Session heartbeat enabled flag must be a boolean."),
    everyMinutes,
    nextFireAt: requireTimestampMillis(row.next_fire_at, "Session next_fire_at must be a valid timestamp."),
    lastFireAt: optionalTimestampMillis(row.last_fire_at, "Session last_fire_at must be a valid timestamp."),
    lastSkipReason: optionalSessionString("last skip reason", row.last_skip_reason),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Session claimed_at must be a valid timestamp."),
    claimedBy: optionalSessionString("claim owner", row.claimed_by),
    claimExpiresAt: optionalTimestampMillis(row.claim_expires_at, "Session claim_expires_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Session created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session updated_at must be a valid timestamp."),
  };
}

function normalizeSessionPromptContent(value: string): string {
  if (!value.trim()) {
    throw new Error("Session prompt content must not be empty.");
  }

  return value;
}

function parseSessionPromptRow(row: Record<string, unknown>): SessionPromptRecord {
  return {
    sessionId: requireSessionString("id", row.session_id),
    slug: normalizeSessionPromptSlug(requireSessionString("prompt slug", row.slug)),
    content: typeof row.content === "string" ? row.content : requireSessionString("prompt content", row.content),
    createdAt: requireTimestampMillis(row.created_at, "Session prompt created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session prompt updated_at must be a valid timestamp."),
  };
}

function parseSessionTodoItems(value: unknown): readonly unknown[] {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Session todo items must be an array.");
    }
    return parsed;
  }

  if (!Array.isArray(value)) {
    throw new Error("Session todo items must be an array.");
  }

  return value;
}

function parseSessionTodoRow(row: Record<string, unknown>): SessionTodoRecord {
  return {
    sessionId: requireSessionString("id", row.session_id),
    items: normalizeSessionTodoItems(parseSessionTodoItems(row.items)),
    itemsHash: requireSessionString("todo items hash", row.items_hash),
    createdAt: requireTimestampMillis(row.created_at, "Session todo created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session todo updated_at must be a valid timestamp."),
  };
}

function parseSessionRuntimeThinking(value: unknown): ThinkingLevel | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }

  throw new Error(`Unsupported session runtime thinking level ${String(value)}.`);
}

function parseSessionRuntimeConfigRow(row: Record<string, unknown>): SessionRuntimeConfigRecord {
  const inferenceProjection = readOptionalJsonValue(
    row.inference_projection,
    "Session runtime inference projection",
  ) as SessionRuntimeConfigRecord["inferenceProjection"];
  return {
    sessionId: requireSessionString("id", row.session_id),
    model: optionalSessionString("runtime model", row.model),
    thinking: parseSessionRuntimeThinking(row.thinking),
    thinkingConfigured: requireBoolean(
      row.thinking_configured,
      "Session runtime thinking_configured flag must be a boolean.",
    ),
    inferenceProjection,
    pendingWakeAt: optionalTimestampMillis(
      row.pending_wake_at,
      "Session runtime pending_wake_at must be a valid timestamp.",
    ),
    createdAt: optionalTimestampMillis(
      row.created_at,
      "Session runtime created_at must be a valid timestamp.",
    ),
    updatedAt: optionalTimestampMillis(
      row.updated_at,
      "Session runtime updated_at must be a valid timestamp.",
    ),
  };
}

function resolveSessionPromptSlug(slug?: SessionPromptSlug): SessionPromptSlug {
  return normalizeSessionPromptSlug(slug ?? SESSION_BRIEFING_PROMPT_SLUG);
}

function missingSessionError(sessionId: string): Error {
  return new Error(`Unknown session ${sessionId}`);
}

function missingHeartbeatError(sessionId: string): Error {
  return new Error(`Unknown heartbeat for session ${sessionId}`);
}

async function assertAliasDoesNotCollideWithCanonicalId(input: {
  queryable: PgQueryable;
  tableName: string;
  agentKey: string;
  alias: string | null;
  currentSessionId?: string;
}): Promise<void> {
  if (!input.alias) {
    return;
  }

  const canonicalSessionId = `${input.agentKey}:${input.alias}`;
  const result = await input.queryable.query(
    `SELECT * FROM ${input.tableName} WHERE id = $1 LIMIT 1`,
    [canonicalSessionId],
  );
  const row = result.rows[0];
  if (!row) {
    return;
  }

  const session = parseSessionRow(row as Record<string, unknown>);
  if (session.id === input.currentSessionId) {
    return;
  }

  throw new Error(
    `Session alias ${input.alias} collides with canonical session ${canonicalSessionId}. Pick a different alias.`,
  );
}

export class PostgresSessionStore implements SessionStore {
  private readonly pool: PgPoolLike;
  private readonly tables: SessionTableNames;
  private readonly threadTableName: string;

  constructor(options: PostgresSessionStoreOptions) {
    this.pool = options.pool;
    this.tables = buildSessionTableNames();
    this.threadTableName = buildThreadRuntimeTableNames().threads;
  }

  private async hasThreadTable(queryable: PgQueryable = this.pool): Promise<boolean> {
    const result = await queryable.query(`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'runtime'
        AND table_name = 'threads'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresSessionSchema(this.pool);
  }

  async createSessionRecord(input: CreateSessionInput, queryable: PgQueryable = this.pool): Promise<SessionRecord> {
    const agentKey = requireSessionString("agent key", input.agentKey);
    const alias = normalizeOptionalSessionAlias(input.alias);
    await assertAliasDoesNotCollideWithCanonicalId({
      queryable,
      tableName: this.tables.sessions,
      agentKey,
      alias,
      currentSessionId: input.id,
    });

    const result = await queryable.query(`
      INSERT INTO ${this.tables.sessions} (
        id,
        agent_key,
        kind,
        current_thread_id,
        created_by_identity_id,
        alias,
        display_name,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb
      )
      RETURNING *
    `, [
      requireSessionString("id", input.id),
      agentKey,
      parseSessionKind(input.kind),
      requireSessionString("current thread id", input.currentThreadId),
      input.createdByIdentityId?.trim() || null,
      alias,
      normalizeOptionalDisplayName(input.displayName),
      stringifyOptionalJsonValue(input.metadata, "Session metadata"),
    ]);

    const session = parseSessionRow(result.rows[0] as Record<string, unknown>);
    await queryable.query(`
      INSERT INTO ${this.tables.sessionHeartbeats} (
        session_id,
        enabled
      ) VALUES (
        $1,
        $2
      )
      ON CONFLICT (session_id) DO NOTHING
    `, [
      session.id,
      session.kind === "main",
    ]);

    return session;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return withTransaction(this.pool, async (client) => {
      const session = await this.createSessionRecord(input, client);
      if (await this.hasThreadTable(client)) {
        await client.query(`
          INSERT INTO ${this.threadTableName} (
            id,
            session_id
          ) VALUES (
            $1,
            $2
          )
        `, [
          session.currentThreadId,
          session.id,
        ]);
      }
      return session;
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.sessions} WHERE id = $1`,
      [requireSessionString("id", sessionId)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingSessionError(sessionId);
    }

    return parseSessionRow(row as Record<string, unknown>);
  }


  async getSessionByAlias(agentKey: string, alias: string): Promise<SessionRecord | null> {
    const normalizedAgentKey = requireSessionString("agent key", agentKey);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessions}
      WHERE alias = $1
    `, [
      normalizeSessionAlias(alias),
    ]);

    const sessions = result.rows.map((row) => parseSessionRow(row as Record<string, unknown>));
    return sessions.find((session) => session.agentKey === normalizedAgentKey) ?? null;
  }

  async resolveSessionRef(input: ResolveSessionRefInput): Promise<SessionRecord> {
    return resolveSessionRef(this, input);
  }

  async getMainSession(agentKey: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessions}
      WHERE agent_key = $1
        AND kind = 'main'
      LIMIT 1
    `, [requireSessionString("agent key", agentKey)]);

    const row = result.rows[0];
    return row ? parseSessionRow(row as Record<string, unknown>) : null;
  }

  async listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessions}
      WHERE agent_key = $1
      ORDER BY CASE WHEN kind = 'main' THEN 0 ELSE 1 END, created_at ASC
    `, [requireSessionString("agent key", agentKey)]);

    return result.rows.map((row) => parseSessionRow(row as Record<string, unknown>));
  }


  async updateSessionLabel(input: UpdateSessionLabelInput): Promise<SessionRecord> {
    const updatesAlias = input.alias !== undefined;
    const updatesDisplayName = input.displayName !== undefined;
    if (!updatesAlias && !updatesDisplayName) {
      return this.getSession(input.sessionId);
    }

    const existingSession = updatesAlias && input.alias !== null
      ? await this.getSession(input.sessionId)
      : null;
    const alias = updatesAlias ? normalizeOptionalSessionAlias(input.alias) : null;
    if (existingSession) {
      await assertAliasDoesNotCollideWithCanonicalId({
        queryable: this.pool,
        tableName: this.tables.sessions,
        agentKey: existingSession.agentKey,
        alias,
        currentSessionId: existingSession.id,
      });
    }

    const result = await this.pool.query(`
      UPDATE ${this.tables.sessions}
      SET alias = CASE WHEN $2 THEN $3::text ELSE alias END,
          display_name = CASE WHEN $4 THEN $5::text ELSE display_name END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      updatesAlias,
      alias,
      updatesDisplayName,
      updatesDisplayName ? normalizeOptionalDisplayName(input.displayName) : null,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingSessionError(input.sessionId);
    }

    return parseSessionRow(row as Record<string, unknown>);
  }

  async updateCurrentThreadRecord(
    input: UpdateSessionCurrentThreadInput,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionRecord> {
    const sessionId = requireSessionString("id", input.sessionId);
    const currentThreadId = requireSessionString("current thread id", input.currentThreadId);
    const threadResult = await queryable.query(`
      SELECT 1
      FROM ${this.threadTableName}
      WHERE session_id = $1
        AND id = $2
      LIMIT 1
    `, [
      sessionId,
      currentThreadId,
    ]);
    if (threadResult.rows.length === 0) {
      throw new Error(`Thread ${currentThreadId} does not belong to session ${sessionId}.`);
    }

    const result = await queryable.query(`
      UPDATE ${this.tables.sessions}
      SET current_thread_id = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      sessionId,
      currentThreadId,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingSessionError(input.sessionId);
    }

    return parseSessionRow(row as Record<string, unknown>);
  }

  async updateCurrentThread(input: UpdateSessionCurrentThreadInput): Promise<SessionRecord> {
    return this.updateCurrentThreadRecord(input);
  }

  async getSessionRuntimeConfigRecord(
    sessionId: string,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionRuntimeConfigRecord> {
    const normalizedSessionId = requireSessionString("id", sessionId);
    const result = await queryable.query(`
      SELECT *
      FROM ${this.tables.sessionRuntimeConfig}
      WHERE session_id = $1
    `, [normalizedSessionId]);
    const row = result.rows[0];
    if (row) {
      return parseSessionRuntimeConfigRow(row as Record<string, unknown>);
    }

    await this.getSession(normalizedSessionId);
    return {
      sessionId: normalizedSessionId,
      thinkingConfigured: false,
    };
  }

  async getSessionRuntimeConfig(sessionId: string): Promise<SessionRuntimeConfigRecord> {
    return this.getSessionRuntimeConfigRecord(sessionId);
  }

  async updateSessionRuntimeConfigRecord(
    input: UpdateSessionRuntimeConfigInput,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionRuntimeConfigRecord> {
    const updatesModel = input.model !== undefined;
    const updatesThinking = input.thinking !== undefined;
    const updatesInferenceProjection = input.inferenceProjection !== undefined;
    const updatesPendingWake = input.pendingWakeAt !== undefined;
    if (!updatesModel && !updatesThinking && !updatesInferenceProjection && !updatesPendingWake) {
      return this.getSessionRuntimeConfigRecord(input.sessionId, queryable);
    }

    const sessionId = requireSessionString("id", input.sessionId);
    const model = updatesModel && input.model !== null && input.model !== undefined
      ? resolveModelSelector(input.model).canonical
      : null;
    const inferenceProjectionValue = updatesInferenceProjection && input.inferenceProjection !== null
      ? input.inferenceProjection as JsonValue
      : undefined;
    const inferenceProjection = updatesInferenceProjection
      ? stringifyOptionalJsonValue(inferenceProjectionValue, "Session runtime inference projection")
      : null;
    const pendingWakeAt = updatesPendingWake && input.pendingWakeAt !== null && input.pendingWakeAt !== undefined
      ? new Date(input.pendingWakeAt)
      : null;

    const result = await queryable.query(`
      INSERT INTO ${this.tables.sessionRuntimeConfig} (
        session_id,
        model,
        thinking,
        thinking_configured,
        inference_projection,
        pending_wake_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        $6
      )
      ON CONFLICT (session_id) DO UPDATE
      SET model = CASE WHEN $7 THEN EXCLUDED.model ELSE ${this.tables.sessionRuntimeConfig}.model END,
          thinking = CASE WHEN $8 THEN EXCLUDED.thinking ELSE ${this.tables.sessionRuntimeConfig}.thinking END,
          thinking_configured = CASE WHEN $8 THEN TRUE ELSE ${this.tables.sessionRuntimeConfig}.thinking_configured END,
          inference_projection = CASE WHEN $9 THEN EXCLUDED.inference_projection ELSE ${this.tables.sessionRuntimeConfig}.inference_projection END,
          pending_wake_at = CASE WHEN $10 THEN EXCLUDED.pending_wake_at ELSE ${this.tables.sessionRuntimeConfig}.pending_wake_at END,
          updated_at = NOW()
      RETURNING *
    `, [
      sessionId,
      model,
      updatesThinking ? input.thinking : null,
      updatesThinking,
      inferenceProjection,
      pendingWakeAt,
      updatesModel,
      updatesThinking,
      updatesInferenceProjection,
      updatesPendingWake,
    ]);

    return parseSessionRuntimeConfigRow(result.rows[0] as Record<string, unknown>);
  }

  async updateSessionRuntimeConfig(
    input: UpdateSessionRuntimeConfigInput,
  ): Promise<SessionRuntimeConfigRecord> {
    return this.updateSessionRuntimeConfigRecord(input);
  }

  async readSessionPrompt(
    sessionId: string,
    slug: SessionPromptSlug = SESSION_BRIEFING_PROMPT_SLUG,
  ): Promise<SessionPromptRecord | null> {
    const result = await this.pool.query(`
      SELECT * FROM ${this.tables.sessionPrompts}
      WHERE session_id = $1 AND slug = $2
    `, [
      requireSessionString("id", sessionId),
      resolveSessionPromptSlug(slug),
    ]);
    const row = result.rows[0];
    return row ? parseSessionPromptRow(row as Record<string, unknown>) : null;
  }

  async listSessionPrompts(sessionId: string): Promise<readonly SessionPromptRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM ${this.tables.sessionPrompts}
      WHERE session_id = $1
      ORDER BY slug ASC
    `, [requireSessionString("id", sessionId)]);
    return result.rows.map((row) => parseSessionPromptRow(row as Record<string, unknown>));
  }

  async setSessionPrompt(input: SetSessionPromptInput): Promise<SessionPromptRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.sessionPrompts} (
        session_id,
        slug,
        content
      ) VALUES (
        $1,
        $2,
        $3
      )
      ON CONFLICT (session_id, slug) DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      resolveSessionPromptSlug(input.slug),
      normalizeSessionPromptContent(input.content),
    ]);
    return parseSessionPromptRow(result.rows[0] as Record<string, unknown>);
  }

  async deleteSessionPrompt(input: DeleteSessionPromptInput): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.sessionPrompts}
      WHERE session_id = $1 AND slug = $2
    `, [
      requireSessionString("id", input.sessionId),
      resolveSessionPromptSlug(input.slug),
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async readSessionTodo(sessionId: string): Promise<SessionTodoRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionTodos}
      WHERE session_id = $1
    `, [requireSessionString("id", sessionId)]);
    const row = result.rows[0];
    return row ? parseSessionTodoRow(row as Record<string, unknown>) : null;
  }

  async replaceSessionTodo(input: ReplaceSessionTodoInput): Promise<SessionTodoRecord | null> {
    const sessionId = requireSessionString("id", input.sessionId);
    const items = normalizeSessionTodoItems(input.items);
    if (items.length === 0) {
      const deleteResult = await this.pool.query(`
        DELETE FROM ${this.tables.sessionTodos}
        WHERE session_id = $1
      `, [sessionId]);
      if ((deleteResult.rowCount ?? 0) === 0) {
        const sessionResult = await this.pool.query(`
          SELECT 1
          FROM ${this.tables.sessions}
          WHERE id = $1
          LIMIT 1
        `, [sessionId]);
        if (sessionResult.rows.length === 0) {
          throw missingSessionError(sessionId);
        }
      }
      return null;
    }

    const itemsHash = calculateSessionTodoItemsHash(items);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.sessionTodos} (
        session_id,
        items,
        items_hash
      ) VALUES (
        $1,
        $2::jsonb,
        $3
      )
      ON CONFLICT (session_id) DO UPDATE SET
        items = EXCLUDED.items,
        items_hash = EXCLUDED.items_hash,
        updated_at = NOW()
      RETURNING *
    `, [
      sessionId,
      JSON.stringify(items),
      itemsHash,
    ]);
    return parseSessionTodoRow(result.rows[0] as Record<string, unknown>);
  }

  async getHeartbeat(sessionId: string): Promise<SessionHeartbeatRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionHeartbeats}
      WHERE session_id = $1
    `, [requireSessionString("id", sessionId)]);
    const row = result.rows[0];
    return row ? parseHeartbeatRow(row as Record<string, unknown>) : null;
  }

  async listDueHeartbeats(input: ListDueSessionHeartbeatsInput = {}): Promise<readonly SessionHeartbeatRecord[]> {
    const asOf = new Date(input.asOf ?? Date.now());
    const limit = input.limit ?? 100;
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sessionHeartbeats}
      WHERE enabled = TRUE
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= $1
        AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
      ORDER BY next_fire_at ASC, session_id ASC
      LIMIT $2
    `, [asOf, limit]);

    return result.rows.map((row) => parseHeartbeatRow(row as Record<string, unknown>));
  }

  async claimHeartbeat(input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null> {
    const asOf = new Date(input.asOf ?? Date.now());
    const result = await this.pool.query(`
      UPDATE ${this.tables.sessionHeartbeats}
      SET claimed_at = NOW(),
          claimed_by = $2,
          claim_expires_at = $3,
          updated_at = NOW()
      WHERE session_id = $1
        AND enabled = TRUE
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= $4
        AND (claim_expires_at IS NULL OR claim_expires_at <= $4)
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      requireSessionString("claim owner", input.claimedBy),
      new Date(input.claimExpiresAt),
      asOf,
    ]);

    const row = result.rows[0];
    return row ? parseHeartbeatRow(row as Record<string, unknown>) : null;
  }

  async recordHeartbeatResult(input: RecordSessionHeartbeatResultInput): Promise<SessionHeartbeatRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.sessionHeartbeats}
      SET next_fire_at = $3,
          last_fire_at = COALESCE($4, last_fire_at),
          last_skip_reason = $5,
          claimed_at = NULL,
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE session_id = $1
        AND claimed_by = $2
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      requireSessionString("claim owner", input.claimedBy),
      new Date(input.nextFireAt),
      input.lastFireAt === undefined ? null : new Date(input.lastFireAt),
      input.lastSkipReason ?? null,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingHeartbeatError(input.sessionId);
    }

    return parseHeartbeatRow(row as Record<string, unknown>);
  }

  async updateHeartbeatConfig(input: UpdateSessionHeartbeatConfigInput): Promise<SessionHeartbeatRecord> {
    const existing = await this.getHeartbeat(input.sessionId);
    if (!existing) {
      throw missingHeartbeatError(input.sessionId);
    }

    const enabled = input.enabled ?? existing.enabled;
    const everyMinutes = input.everyMinutes === undefined
      ? existing.everyMinutes
      : requireHeartbeatEveryMinutes(input.everyMinutes);
    const asOf = input.asOf ?? Date.now();
    const nextFireAt = enabled
      ? asOf + everyMinutes * 60_000
      : existing.nextFireAt;

    const result = await this.pool.query(`
      UPDATE ${this.tables.sessionHeartbeats}
      SET enabled = $2,
          every_minutes = $3,
          next_fire_at = $4,
          claimed_at = NULL,
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE session_id = $1
      RETURNING *
    `, [
      requireSessionString("id", input.sessionId),
      enabled,
      everyMinutes,
      new Date(nextFireAt),
    ]);
    return parseHeartbeatRow(result.rows[0] as Record<string, unknown>);
  }
}
