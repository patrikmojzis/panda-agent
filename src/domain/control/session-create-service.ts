import {createHash, randomUUID} from "node:crypto";

import type {PgPoolLike} from "../../lib/postgres-query.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import {normalizeAgentKey} from "../agents/types.js";
import type {AgentStore} from "../agents/store.js";
import {createSessionWithInitialThread} from "../sessions/lifecycle.js";
import type {PostgresSessionStore} from "../sessions/postgres.js";
import {normalizeSessionAlias} from "../sessions/types.js";
import type {SessionRecord} from "../sessions/types.js";
import type {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import type {ThreadRecord} from "../threads/runtime/types.js";
import type {ControlSessionRecord} from "./types.js";

export interface ControlCreateSessionInput {
  sessionRef?: string;
  alias?: string;
  displayName?: string;
}

export interface ControlCreateSessionRecord {
  agentKey: string;
  sessionId: string;
  threadId: string;
  kind: "branch";
  alias?: string;
  displayName?: string;
  links: {
    briefing: string;
    heartbeat: string;
    todos: string;
    watches: string;
    runtimeActivity: string;
    scheduledTasks: string;
  };
}

export interface ControlSessionCreateAudit {
  agentKey: string;
  sessionId: string;
  threadId: string;
  kind: "branch";
  usedSessionRef: boolean;
  alias?: string;
  displayName?: {length: number; sha256: string};
}

export interface ControlCreateSessionResult {
  session: ControlCreateSessionRecord;
  audit: ControlSessionCreateAudit;
}

function normalizeSessionRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Session ref must not be empty.");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("Session ref must use letters, numbers, hyphens, or underscores, and start with a letter or number.");
  }
  return normalized;
}

function normalizeOptionalDisplayName(value: string | undefined): string | undefined {
  const trimmed = optionalNonEmptyString(value, "Session display name must not be empty.");
  return trimmed;
}

function publicSession(session: SessionRecord, thread: ThreadRecord): ControlCreateSessionRecord {
  const base = `/agents/${encodeURIComponent(session.agentKey)}/sessions/${encodeURIComponent(session.id)}`;
  return {
    agentKey: session.agentKey,
    sessionId: session.id,
    threadId: thread.id,
    kind: "branch",
    ...(session.alias ? {alias: session.alias} : {}),
    ...(session.displayName ? {displayName: session.displayName} : {}),
    links: {
      briefing: `${base}/briefing`,
      heartbeat: `${base}/heartbeat`,
      todos: `${base}/todos`,
      watches: `${base}/watches`,
      runtimeActivity: `${base}/runtime-activity`,
      scheduledTasks: `${base}/scheduled-tasks`,
    },
  };
}

function summarizeDisplayName(displayName: string | undefined): ControlSessionCreateAudit["displayName"] {
  if (displayName === undefined) return undefined;
  return {length: displayName.length, sha256: createHash("sha256").update(displayName).digest("hex")};
}

export class ControlSessionCreateService {
  constructor(private readonly options: {
    pool: PgPoolLike;
    agents: AgentStore;
    sessions: PostgresSessionStore;
    threads: PostgresThreadRuntimeStore;
  }) {}

  async createSession(controlSession: ControlSessionRecord, agentKey: string, input: ControlCreateSessionInput): Promise<ControlCreateSessionResult> {
    if (controlSession.role !== "admin") {
      throw new Error("Control session creation requires an admin grant.");
    }

    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const agent = await this.options.agents.getAgent(normalizedAgentKey);
    const normalizedRef = input.sessionRef === undefined ? undefined : normalizeSessionRef(input.sessionRef);
    const alias = input.alias === undefined ? undefined : normalizeSessionAlias(input.alias);
    const displayName = normalizeOptionalDisplayName(input.displayName);
    const sessionId = normalizedRef ? `${agent.agentKey}:${normalizedRef}` : randomUUID();
    const threadId = randomUUID();

    const created = await createSessionWithInitialThread({
      pool: this.options.pool,
      sessionStore: this.options.sessions,
      threadStore: this.options.threads,
      session: {
        id: requireNonEmptyString(sessionId, "Session id is required."),
        agentKey: agent.agentKey,
        kind: "branch",
        currentThreadId: threadId,
        createdByIdentityId: controlSession.identityId,
        ...(alias ? {alias} : {}),
        ...(displayName ? {displayName} : {}),
      },
      thread: {id: threadId, sessionId},
    });

    return {
      session: publicSession(created.session, created.thread),
      audit: {
        agentKey: agent.agentKey,
        sessionId: created.session.id,
        threadId: created.thread.id,
        kind: "branch",
        usedSessionRef: normalizedRef !== undefined,
        ...(alias ? {alias} : {}),
        ...(displayName ? {displayName: summarizeDisplayName(displayName)} : {}),
      },
    };
  }
}
