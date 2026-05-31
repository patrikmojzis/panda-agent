import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {SessionStore} from "../sessions/store.js";
import type {SessionTodoRecord, SessionTodoStatus} from "../sessions/todos.js";
import {SESSION_TODO_STATUSES} from "../sessions/todos.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

export interface ControlTodoItem {
  status: SessionTodoStatus;
  content: string;
}

export type ControlTodoCounts = Record<SessionTodoStatus, number>;

export interface ControlTodoRecord {
  sessionId: string;
  items: readonly ControlTodoItem[];
  itemsHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  counts: ControlTodoCounts;
}

function emptyCounts(): ControlTodoCounts {
  return Object.fromEntries(SESSION_TODO_STATUSES.map((status) => [status, 0])) as ControlTodoCounts;
}

function publicTodo(sessionId: string, todo: SessionTodoRecord | null): ControlTodoRecord {
  const items = todo?.items.map((item) => ({status: item.status, content: item.content})) ?? [];
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;
  return {
    sessionId,
    items,
    itemsHash: todo?.itemsHash ?? null,
    createdAt: todo ? new Date(todo.createdAt).toISOString() : null,
    updatedAt: todo ? new Date(todo.updatedAt).toISOString() : null,
    counts,
  };
}

export class ControlTodoService {
  private readonly pool: PgQueryable;
  private readonly sessions: Pick<SessionStore, "readSessionTodo">;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();

  constructor(options: {pool: PgQueryable; sessions: Pick<SessionStore, "readSessionTodo">}) {
    this.pool = options.pool;
    this.sessions = options.sessions;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.sessionTables.sessions} AS target_session
      INNER JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND (grant_row.role = 'admin' OR (grant_row.role = 'scoped' AND grant_row.agent_key = target_session.agent_key))
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey]);
    if (result.rows.length === 0) {
      throw new Error("Control todo target session was not found or is not visible.");
    }
  }

  async getTodo(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<ControlTodoRecord> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const todo = await this.sessions.readSessionTodo(targetSessionId);
    return publicTodo(targetSessionId, todo);
  }
}
