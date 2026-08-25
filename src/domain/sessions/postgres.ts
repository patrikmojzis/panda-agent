import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import type {ThinkingLevel} from "@earendil-works/pi-ai";

import {resolveModelSelector} from "../../kernel/models/model-selector.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {buildRuntimeRequestTableNames} from "../threads/requests/postgres-shared.js";
import {requireBoolean} from "../../lib/booleans.js";
import {type JsonValue, readOptionalJsonValue, stringifyOptionalJsonValue} from "../../lib/json.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import {resolveSessionRef} from "./refs.js";
import {buildSessionTableNames, type SessionTableNames} from "./postgres-shared.js";
import type {SessionStore} from "./store.js";
import type {ReplaceSessionTodoInput, SessionTodoRecord} from "./todos.js";
import {calculateSessionTodoItemsHash, normalizeSessionTodoItems} from "./todos.js";
import type {
  ClaimSessionHeartbeatInput,
  CreateSessionInput,
  DeleteSessionPromptInput,
  ListDueSessionHeartbeatsInput,
  ListAgentSessionsInput,
  RecordSessionHeartbeatResultInput,
  ResolveSessionRefInput,
  SessionHeartbeatRecord,
  SessionPromptRecord,
  SessionPromptSlug,
  SessionRecord,
  SessionRuntimeConfigRecord,
  SessionRuntimeConfigOperationRecord,
  SessionCreationOperationRecord,
  SetSessionPromptInput,
  TransformSessionPromptInput,
  TransformSessionPromptResult,
  UpdateSessionCurrentThreadInput,
  UpdateSessionHeartbeatConfigInput,
  UpdateSessionLabelInput,
  UpdateSessionRuntimeConfigInput,
} from "./types.js";
import {DEFAULT_SESSION_PROMPT_TEMPLATES} from "../../prompts/templates/session-prompts.js";
import {
  normalizeSessionAlias,
  normalizeSessionPromptSlug,
  SESSION_BRIEF_PROMPT_SLUG,
  SESSION_HEARTBEAT_PROMPT_SLUG,
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
  if (value === "main" || value === "branch" || value === "worker" || value === "subagent") {
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
    archivedAt: optionalTimestampMillis(row.archived_at, "Session archived_at must be a valid timestamp."),
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

function requirePostgresText(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain a NUL byte.`);
  }
  return value;
}

function applyLiteralSessionPromptMutation(
  content: string,
  input: Exclude<TransformSessionPromptInput, {operation: "expression"}>,
): {content: string; matchCount?: number} {
  switch (input.operation) {
    case "append":
      return {content: content + requirePostgresText(input.text, "Session prompt append text")};
    case "prepend":
      return {content: requirePostgresText(input.text, "Session prompt prepend text") + content};
    case "replace": {
      const pattern = requirePostgresText(input.pattern, "Session prompt replace pattern");
      const replacement = requirePostgresText(input.replacement, "Session prompt replacement text");
      if (!pattern) {
        throw new Error("Session prompt replace pattern must not be empty.");
      }
      const parts = content.split(pattern);
      return {
        content: parts.join(replacement),
        matchCount: parts.length - 1,
      };
    }
  }
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
  return normalizeSessionPromptSlug(slug ?? SESSION_BRIEF_PROMPT_SLUG);
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

    if (session.kind === "main") {
      const brief = DEFAULT_SESSION_PROMPT_TEMPLATES.brief;
      if (brief) {
        await queryable.query(`
          INSERT INTO ${this.tables.sessionPrompts} (
            session_id,
            slug,
            content
          ) VALUES (
            $1,
            $2,
            $3
          )
          ON CONFLICT (session_id, slug) DO NOTHING
        `, [
          session.id,
          SESSION_BRIEF_PROMPT_SLUG,
          brief,
        ]);
      }
    } else if (session.kind === "branch") {
      await queryable.query(`
        INSERT INTO ${this.tables.sessionPrompts} (
          session_id,
          slug,
          content
        )
        SELECT
          $1,
          prompt.slug,
          prompt.content
        FROM ${this.tables.sessions} AS main_session
        INNER JOIN ${this.tables.sessionPrompts} AS prompt
          ON prompt.session_id = main_session.id
        WHERE main_session.agent_key = $2
          AND main_session.kind = 'main'
          AND prompt.slug IN ($3, $4)
        ON CONFLICT (session_id, slug) DO NOTHING
      `, [
        session.id,
        session.agentKey,
        SESSION_BRIEF_PROMPT_SLUG,
        SESSION_HEARTBEAT_PROMPT_SLUG,
      ]);
    }

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
        AND archived_at IS NULL
      LIMIT 1
    `, [requireSessionString("agent key", agentKey)]);

    const row = result.rows[0];
    return row ? parseSessionRow(row as Record<string, unknown>) : null;
  }

  async listAgentSessions(
    agentKey: string,
    input: ListAgentSessionsInput = {},
  ): Promise<readonly SessionRecord[]> {
    const lifecyclePredicate = input.lifecycle === "all"
      ? ""
      : input.lifecycle === "archived"
        ? "AND session.archived_at IS NOT NULL"
        : "AND session.archived_at IS NULL";
    const result = await this.pool.query(`
      SELECT session.*
      FROM ${this.tables.sessions} AS session
      WHERE session.agent_key = $1
        ${lifecyclePredicate}
      ORDER BY session.created_at ASC, session.id ASC
    `, [requireSessionString("agent key", agentKey)]);

    return result.rows
      .map((row) => parseSessionRow(row as Record<string, unknown>))
      .sort((left, right) => {
        const leftRank = left.kind === "main" ? 0 : 1;
        const rightRank = right.kind === "main" ? 0 : 1;
        return leftRank - rightRank || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
      });
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
    queryable?: PgQueryable,
    settingsOrder?: {appliedAt: Date; operationId: string},
  ): Promise<SessionRuntimeConfigRecord> {
    if (!queryable) {
      return withTransaction(this.pool, (client) => {
        return this.updateSessionRuntimeConfigRecord(input, client, settingsOrder);
      });
    }
    const updatesModel = input.model !== undefined;
    const updatesThinking = input.thinking !== undefined;
    const updatesThinkingConfigured = input.thinkingConfigured !== undefined;
    const updatesThinkingState = updatesThinking || updatesThinkingConfigured;
    const updatesInferenceProjection = input.inferenceProjection !== undefined;
    if (!updatesModel && !updatesThinkingState && !updatesInferenceProjection) {
      return this.getSessionRuntimeConfigRecord(input.sessionId, queryable);
    }
    if (input.thinkingConfigured === false && input.thinking !== undefined && input.thinking !== null) {
      throw new Error("Session runtime thinking cannot be set while thinking configuration is cleared.");
    }

    const sessionId = requireSessionString("id", input.sessionId);
    const lockedSession = await queryable.query(`
      SELECT id
      FROM ${this.tables.sessions}
      WHERE id = $1
      FOR UPDATE
    `, [sessionId]);
    if (lockedSession.rows.length === 0) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const model = updatesModel && input.model !== null && input.model !== undefined
      ? resolveModelSelector(input.model).canonical
      : null;
    const thinkingConfigured = updatesThinkingState
      ? input.thinkingConfigured ?? true
      : false;
    const thinking = thinkingConfigured && updatesThinking
      ? input.thinking
      : null;
    const inferenceProjectionValue = updatesInferenceProjection && input.inferenceProjection !== null
      ? input.inferenceProjection as JsonValue
      : undefined;
    const inferenceProjection = updatesInferenceProjection
      ? stringifyOptionalJsonValue(inferenceProjectionValue, "Session runtime inference projection")
      : null;
    const result = await queryable.query(`
      INSERT INTO ${this.tables.sessionRuntimeConfig} (
        session_id,
        model,
        thinking,
        thinking_configured,
        inference_projection,
        model_applied_at,
        model_operation_id,
        thinking_applied_at,
        thinking_operation_id,
        inference_projection_applied_at,
        inference_projection_operation_id
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        CASE WHEN $6 THEN ${settingsOrder ? "$9" : "NOW()"} ELSE TIMESTAMPTZ '1970-01-01 00:00:00+00' END,
        CASE WHEN $6 THEN ${settingsOrder ? "$10::uuid" : "NULL"} ELSE NULL END,
        CASE WHEN $7 THEN ${settingsOrder ? "$9" : "NOW()"} ELSE TIMESTAMPTZ '1970-01-01 00:00:00+00' END,
        CASE WHEN $7 THEN ${settingsOrder ? "$10::uuid" : "NULL"} ELSE NULL END,
        CASE WHEN $8 THEN ${settingsOrder ? "$9" : "NOW()"} ELSE TIMESTAMPTZ '1970-01-01 00:00:00+00' END,
        CASE WHEN $8 THEN ${settingsOrder ? "$10::uuid" : "NULL"} ELSE NULL END
      )
      ON CONFLICT (session_id) DO UPDATE
      SET model = CASE WHEN $6 THEN EXCLUDED.model ELSE ${this.tables.sessionRuntimeConfig}.model END,
          thinking = CASE WHEN $7 THEN EXCLUDED.thinking ELSE ${this.tables.sessionRuntimeConfig}.thinking END,
          thinking_configured = CASE WHEN $7 THEN EXCLUDED.thinking_configured ELSE ${this.tables.sessionRuntimeConfig}.thinking_configured END,
          inference_projection = CASE WHEN $8 THEN EXCLUDED.inference_projection ELSE ${this.tables.sessionRuntimeConfig}.inference_projection END,
          model_applied_at = CASE WHEN $6 THEN EXCLUDED.model_applied_at ELSE ${this.tables.sessionRuntimeConfig}.model_applied_at END,
          model_operation_id = CASE WHEN $6 THEN EXCLUDED.model_operation_id ELSE ${this.tables.sessionRuntimeConfig}.model_operation_id END,
          thinking_applied_at = CASE WHEN $7 THEN EXCLUDED.thinking_applied_at ELSE ${this.tables.sessionRuntimeConfig}.thinking_applied_at END,
          thinking_operation_id = CASE WHEN $7 THEN EXCLUDED.thinking_operation_id ELSE ${this.tables.sessionRuntimeConfig}.thinking_operation_id END,
          inference_projection_applied_at = CASE WHEN $8 THEN EXCLUDED.inference_projection_applied_at ELSE ${this.tables.sessionRuntimeConfig}.inference_projection_applied_at END,
          inference_projection_operation_id = CASE WHEN $8 THEN EXCLUDED.inference_projection_operation_id ELSE ${this.tables.sessionRuntimeConfig}.inference_projection_operation_id END,
          updated_at = NOW()
      RETURNING *
    `, [
      sessionId,
      model,
      thinking,
      thinkingConfigured,
      inferenceProjection,
      updatesModel,
      updatesThinkingState,
      updatesInferenceProjection,
      ...(settingsOrder ? [settingsOrder.appliedAt, settingsOrder.operationId] : []),
    ]);

    return parseSessionRuntimeConfigRow(result.rows[0] as Record<string, unknown>);
  }

  async updateSessionRuntimeConfig(
    input: UpdateSessionRuntimeConfigInput,
  ): Promise<SessionRuntimeConfigRecord> {
    return this.updateSessionRuntimeConfigRecord(input);
  }

  async updateSessionRuntimeConfigForOperationRecord(
    operationId: string,
    input: UpdateSessionRuntimeConfigInput,
    queryable: PgQueryable,
  ): Promise<SessionRuntimeConfigRecord> {
    const normalizedOperationId = requireSessionString("runtime config operation id", operationId);
    const normalizedSessionId = requireSessionString("id", input.sessionId);
    const updatesModel = input.model !== undefined;
    const updatesThinkingState = input.thinking !== undefined || input.thinkingConfigured !== undefined;
    const updatesInferenceProjection = input.inferenceProjection !== undefined;
    const lockedSession = await queryable.query(`
      SELECT id
      FROM ${this.tables.sessions}
      WHERE id = $1
      FOR UPDATE
    `, [normalizedSessionId]);
    if (lockedSession.rows.length === 0) {
      throw new Error(`Unknown session ${normalizedSessionId}`);
    }

    const requestTable = buildRuntimeRequestTableNames().runtimeRequests;
    const ordering = await queryable.query(`
      SELECT request.created_at AS requested_at,
             config.session_id IS NULL
               OR request.created_at > config.model_applied_at
               OR (
                 request.created_at = config.model_applied_at
                 AND (
                   config.model_operation_id IS NULL
                   OR request.id > config.model_operation_id
                 )
               ) AS apply_model,
             config.session_id IS NULL
               OR request.created_at > config.thinking_applied_at
               OR (
                 request.created_at = config.thinking_applied_at
                 AND (
                   config.thinking_operation_id IS NULL
                   OR request.id > config.thinking_operation_id
                 )
               ) AS apply_thinking,
             config.session_id IS NULL
               OR request.created_at > config.inference_projection_applied_at
               OR (
                 request.created_at = config.inference_projection_applied_at
                 AND (
                   config.inference_projection_operation_id IS NULL
                   OR request.id > config.inference_projection_operation_id
                 )
               ) AS apply_inference_projection
      FROM ${requestTable} AS request
      LEFT JOIN ${this.tables.sessionRuntimeConfig} AS config
        ON config.session_id = $2
      WHERE request.id = $1
    `, [normalizedOperationId, normalizedSessionId]);
    const order = ordering.rows[0] as {
      requested_at?: unknown;
      apply_model?: unknown;
      apply_thinking?: unknown;
      apply_inference_projection?: unknown;
    } | undefined;
    if (!order) {
      throw new Error(`Unknown runtime config operation ${normalizedOperationId}.`);
    }
    if (!(order.requested_at instanceof Date)) {
      throw new Error(`Runtime config operation ${normalizedOperationId} has an invalid creation timestamp.`);
    }
    const orderedInput: UpdateSessionRuntimeConfigInput = {
      sessionId: normalizedSessionId,
      ...(updatesModel && order.apply_model === true ? {model: input.model} : {}),
      ...(updatesThinkingState && order.apply_thinking === true
        ? {
            ...(input.thinking !== undefined ? {thinking: input.thinking} : {}),
            ...(input.thinkingConfigured !== undefined ? {thinkingConfigured: input.thinkingConfigured} : {}),
          }
        : {}),
      ...(updatesInferenceProjection && order.apply_inference_projection === true
        ? {inferenceProjection: input.inferenceProjection}
        : {}),
    };
    if (Object.keys(orderedInput).length === 1) {
      return this.getSessionRuntimeConfigRecord(normalizedSessionId, queryable);
    }
    return this.updateSessionRuntimeConfigRecord(orderedInput, queryable, {
      appliedAt: order.requested_at,
      operationId: normalizedOperationId,
    });
  }

  async updateSessionRuntimeConfigOnce(
    operationId: string,
    threadId: string,
    input: UpdateSessionRuntimeConfigInput,
  ): Promise<{config: SessionRuntimeConfigRecord; replayed: boolean}> {
    const normalizedOperationId = requireSessionString("runtime config operation id", operationId);
    const normalizedThreadId = requireSessionString("runtime config thread id", threadId);
    const normalizedSessionId = requireSessionString("id", input.sessionId);
    return withTransaction(this.pool, async (client) => {
      const lockedSession = await client.query(`
        SELECT id
        FROM ${this.tables.sessions}
        WHERE id = $1
        FOR UPDATE
      `, [normalizedSessionId]);
      if (lockedSession.rows.length === 0) {
        throw new Error(`Unknown session ${normalizedSessionId}`);
      }
      const inserted = await client.query(`
        INSERT INTO ${this.tables.sessionRuntimeConfigOperations} (
          operation_id,
          session_id,
          thread_id
        )
        SELECT $1, thread.session_id, thread.id
        FROM ${this.threadTableName} AS thread
        WHERE thread.id = $2
          AND thread.session_id = $3
        ON CONFLICT (operation_id) DO NOTHING
        RETURNING session_id, thread_id
      `, [normalizedOperationId, normalizedThreadId, normalizedSessionId]);
      if (inserted.rows.length > 0) {
        return {
          config: await this.updateSessionRuntimeConfigForOperationRecord(
            normalizedOperationId,
            input,
            client,
          ),
          replayed: false,
        };
      }

      const existing = await client.query(`
        SELECT session_id, thread_id
        FROM ${this.tables.sessionRuntimeConfigOperations}
        WHERE operation_id = $1
      `, [normalizedOperationId]);
      const receipt = existing.rows[0] as {session_id?: unknown; thread_id?: unknown} | undefined;
      if (receipt?.session_id !== normalizedSessionId || receipt.thread_id !== normalizedThreadId) {
        throw new Error(`Session runtime config operation ${normalizedOperationId} conflicts with another target.`);
      }
      // A later update may have legitimately changed the row. Replays return
      // its current state but never reapply this operation's stale values.
      return {
        config: await this.getSessionRuntimeConfigRecord(normalizedSessionId, client),
        replayed: true,
      };
    });
  }

  async getSessionRuntimeConfigOperation(
    operationId: string,
  ): Promise<SessionRuntimeConfigOperationRecord | null> {
    const normalizedOperationId = requireSessionString("runtime config operation id", operationId);
    const result = await this.pool.query(`
      SELECT operation_id, session_id, thread_id, created_at
      FROM ${this.tables.sessionRuntimeConfigOperations}
      WHERE operation_id = $1
    `, [normalizedOperationId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      operationId: requireSessionString("runtime config operation id", row.operation_id),
      sessionId: requireSessionString("runtime config operation session id", row.session_id),
      threadId: requireSessionString("runtime config operation thread id", row.thread_id),
      createdAt: requireTimestampMillis(
        row.created_at,
        "Session runtime config operation created_at must be valid.",
      ),
    };
  }

  async getSessionCreationOperationRecord(
    operationId: string,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionCreationOperationRecord | null> {
    const result = await queryable.query(`
      SELECT *
      FROM ${this.tables.sessionCreationOperations}
      WHERE operation_id = $1
    `, [requireSessionString("creation operation id", operationId)]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const kind = requireSessionString("creation operation kind", row.kind);
    if (kind !== "main" && kind !== "branch" && kind !== "subagent") {
      throw new Error(`Session creation operation kind ${kind} is invalid.`);
    }
    return {
      operationId: requireSessionString("creation operation id", row.operation_id),
      identityId: requireSessionString("creation operation identity id", row.identity_id),
      agentKey: requireSessionString("creation operation agent key", row.agent_key),
      sessionId: requireSessionString("creation operation session id", row.session_id),
      threadId: requireSessionString("creation operation thread id", row.thread_id),
      kind,
      createdAt: requireTimestampMillis(row.created_at, "Session creation operation created_at must be valid."),
    };
  }

  async getSessionCreationOperation(operationId: string): Promise<SessionCreationOperationRecord | null> {
    return this.getSessionCreationOperationRecord(operationId);
  }

  async recordSessionCreationOperationRecord(
    input: Omit<SessionCreationOperationRecord, "createdAt">,
    queryable: PgQueryable = this.pool,
  ): Promise<SessionCreationOperationRecord> {
    await queryable.query(`
      INSERT INTO ${this.tables.sessionCreationOperations} (
        operation_id,
        identity_id,
        agent_key,
        session_id,
        thread_id,
        kind
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (operation_id) DO NOTHING
    `, [input.operationId, input.identityId, input.agentKey, input.sessionId, input.threadId, input.kind]);
    const recorded = await this.getSessionCreationOperationRecord(input.operationId, queryable);
    if (
      !recorded
      || recorded.identityId !== input.identityId
      || recorded.agentKey !== input.agentKey
      || recorded.sessionId !== input.sessionId
      || recorded.threadId !== input.threadId
      || recorded.kind !== input.kind
    ) {
      throw new Error(`Session creation operation ${input.operationId} conflicts with another target.`);
    }
    return recorded;
  }

  async recordSessionCreationOperation(
    input: Omit<SessionCreationOperationRecord, "createdAt">,
  ): Promise<SessionCreationOperationRecord> {
    return this.recordSessionCreationOperationRecord(input);
  }

  async recordMainSessionResolutionOperation(input: {
    operationId: string;
    identityId: string;
    agentKey: string;
    sessionId: string;
  }): Promise<SessionCreationOperationRecord> {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(`
        SELECT current_thread_id
        FROM ${this.tables.sessions}
        WHERE id = $1
          AND agent_key = $2
          AND kind = 'main'
        FOR UPDATE
      `, [input.sessionId, input.agentKey]);
      const threadId = (locked.rows[0] as {current_thread_id?: unknown} | undefined)?.current_thread_id;
      if (typeof threadId !== "string" || !threadId) {
        throw new Error(`Main session ${input.sessionId} could not be resolved for operation ${input.operationId}.`);
      }
      return this.recordSessionCreationOperationRecord({
        ...input,
        threadId,
        kind: "main",
      }, client);
    });
  }

  async deleteSubagentCreation(sessionId: string, threadId: string): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.sessions}
      WHERE id = $1
        AND kind = 'subagent'
        AND current_thread_id = $2
      RETURNING id
    `, [
      requireSessionString("id", sessionId),
      requireSessionString("subagent creation thread id", threadId),
    ]);
    return result.rows.length > 0;
  }

  async readSessionPrompt(
    sessionId: string,
    slug: SessionPromptSlug = SESSION_BRIEF_PROMPT_SLUG,
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

  async transformSessionPrompt(
    input: TransformSessionPromptInput,
  ): Promise<TransformSessionPromptResult> {
    const sessionId = requireSessionString("id", input.sessionId);
    const slug = resolveSessionPromptSlug(input.slug);
    return withTransaction(this.pool, async (client) => {
      const sessionLock = await client.query(`
        SELECT 1
        FROM ${this.tables.sessions}
        WHERE id = $1
        FOR UPDATE
      `, [
        sessionId,
      ]);
      if (sessionLock.rows.length === 0) {
        throw missingSessionError(sessionId);
      }

      const existingResult = await client.query(`
        SELECT *
        FROM ${this.tables.sessionPrompts}
        WHERE session_id = $1 AND slug = $2
      `, [
        sessionId,
        slug,
      ]);
      const existingRecord = existingResult.rows[0]
        ? parseSessionPromptRow(existingResult.rows[0] as Record<string, unknown>)
        : null;
      const existingContent = existingRecord?.content ?? "";

      let transformedContent: string;
      let matchCount: number | undefined;
      if (input.operation === "expression") {
        requirePostgresText(input.expression, "Session prompt transform expression");
        const transformedResult = await client.query(`
          SELECT COALESCE((${input.expression})::text, '') AS content
          FROM (SELECT $1::text AS content) AS current_prompt
        `, [
          existingContent,
        ]);
        transformedContent = String((transformedResult.rows[0] as Record<string, unknown> | undefined)?.content ?? "");
      } else {
        const transformed = applyLiteralSessionPromptMutation(existingContent, input);
        transformedContent = transformed.content;
        matchCount = transformed.matchCount;
      }

      if (!transformedContent.trim()) {
        if (!existingRecord) {
          return {
            record: null,
            operation: input.operation,
            changed: false,
            ...(matchCount === undefined ? {} : {matchCount}),
          };
        }
        await client.query(`
          DELETE FROM ${this.tables.sessionPrompts}
          WHERE session_id = $1 AND slug = $2
        `, [
          sessionId,
          slug,
        ]);
        return {
          record: null,
          operation: input.operation,
          changed: true,
          ...(matchCount === undefined ? {} : {matchCount}),
        };
      }

      if (transformedContent === existingContent) {
        return {
          record: existingRecord,
          operation: input.operation,
          changed: false,
          ...(matchCount === undefined ? {} : {matchCount}),
        };
      }

      const result = await client.query(`
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
        sessionId,
        slug,
        transformedContent,
      ]);
      return {
        record: parseSessionPromptRow(result.rows[0] as Record<string, unknown>),
        operation: input.operation,
        changed: true,
        ...(matchCount === undefined ? {} : {matchCount}),
      };
    });
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
      SELECT heartbeat.*
      FROM ${this.tables.sessionHeartbeats} AS heartbeat
      INNER JOIN ${this.tables.sessions} AS session
        ON session.id = heartbeat.session_id
       AND session.archived_at IS NULL
      WHERE heartbeat.enabled = TRUE
        AND heartbeat.next_fire_at IS NOT NULL
        AND heartbeat.next_fire_at <= $1
        AND (heartbeat.claim_expires_at IS NULL OR heartbeat.claim_expires_at <= $1)
      ORDER BY heartbeat.next_fire_at ASC, heartbeat.session_id ASC
      LIMIT $2
    `, [asOf, limit]);

    return result.rows.map((row) => parseHeartbeatRow(row as Record<string, unknown>));
  }

  async claimHeartbeat(input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null> {
    const asOf = new Date(input.asOf ?? Date.now());
    return withTransaction(this.pool, async (client) => {
      const sessionId = requireSessionString("id", input.sessionId);
      const lifecycle = await client.query(`
        SELECT id, archived_at
        FROM ${this.tables.sessions}
        WHERE id = $1
        FOR UPDATE
      `, [sessionId]);
      const lifecycleRow = lifecycle.rows[0] as {archived_at?: unknown} | undefined;
      if (!lifecycleRow || lifecycleRow.archived_at !== null) return null;

      const result = await client.query(`
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
        sessionId,
        requireSessionString("claim owner", input.claimedBy),
        new Date(input.claimExpiresAt),
        asOf,
      ]);
      const row = result.rows[0];
      return row ? parseHeartbeatRow(row as Record<string, unknown>) : null;
    });
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
