import {createHash} from "node:crypto";

import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {SessionStore} from "../sessions/store.js";
import {normalizeSessionPromptSlug, SESSION_BRIEF_PROMPT_SLUG, SESSION_PROMPT_SLUGS, type SessionPromptRecord, type SessionPromptSlug} from "../sessions/types.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

export interface ControlBriefingContentSummary {
  wasSet: boolean;
  length: number;
  sha256: string | null;
}

export interface ControlSessionPromptRecord {
  agentKey: string;
  sessionId: string;
  slug: SessionPromptSlug;
  content: string;
  wasSet: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type ControlBriefingRecord = ControlSessionPromptRecord & {
  slug: typeof SESSION_BRIEF_PROMPT_SLUG;
};

export interface ControlBriefingMutationAudit {
  action: "put" | "delete";
  agentKey: string;
  targetSessionId: string;
  slug: SessionPromptSlug;
  old: ControlBriefingContentSummary;
  next: ControlBriefingContentSummary;
}

function summarizePrompt(prompt: SessionPromptRecord | null): ControlBriefingContentSummary {
  if (!prompt) return {wasSet: false, length: 0, sha256: null};
  return {
    wasSet: true,
    length: prompt.content.length,
    sha256: createHash("sha256").update(prompt.content).digest("hex"),
  };
}

function publicSessionPrompt(
  agentKey: string,
  sessionId: string,
  slug: SessionPromptSlug,
  prompt: SessionPromptRecord | null,
): ControlSessionPromptRecord {
  return {
    agentKey,
    sessionId,
    slug,
    content: prompt?.content ?? "",
    wasSet: prompt !== null,
    ...(prompt ? {createdAt: new Date(prompt.createdAt).toISOString(), updatedAt: new Date(prompt.updatedAt).toISOString()} : {}),
  };
}

function publicBriefing(agentKey: string, sessionId: string, prompt: SessionPromptRecord | null): ControlBriefingRecord {
  return publicSessionPrompt(agentKey, sessionId, SESSION_BRIEF_PROMPT_SLUG, prompt) as ControlBriefingRecord;
}

function emptyContentError(label: "prompt" | "briefing"): Error {
  return new Error(
    label === "briefing"
      ? "Session briefing content must not be blank. Use clear to delete the briefing."
      : "Session prompt content must not be blank. Use clear to delete the prompt.",
  );
}

export class ControlBriefingService {
  private readonly pool: PgQueryable;
  private readonly sessions: Pick<SessionStore, "listSessionPrompts" | "readSessionPrompt" | "setSessionPrompt" | "deleteSessionPrompt">;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();

  constructor(options: {pool: PgQueryable; sessions: Pick<SessionStore, "listSessionPrompts" | "readSessionPrompt" | "setSessionPrompt" | "deleteSessionPrompt">}) {
    this.pool = options.pool;
    this.sessions = options.sessions;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.sessionTables.sessions} AS target_session
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND grant_row.role = $4
       AND (grant_row.role = 'admin' OR grant_row.agent_key = target_session.agent_key)
      LEFT JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
        AND (grant_row.role = 'admin' OR pairing.identity_id IS NOT NULL)
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey, session.role]);
    if (result.rows.length === 0) {
      throw new Error("Control briefing target session was not found or is not visible.");
    }
  }

  async getBriefing(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<ControlBriefingRecord> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const prompt = await this.sessions.readSessionPrompt(targetSessionId, SESSION_BRIEF_PROMPT_SLUG);
    return publicBriefing(agentKey, targetSessionId, prompt);
  }

  async listPrompts(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<readonly ControlSessionPromptRecord[]> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const prompts = await this.sessions.listSessionPrompts(targetSessionId);
    const promptsBySlug = new Map(prompts.map((prompt) => [prompt.slug, prompt]));
    return SESSION_PROMPT_SLUGS.map((slug) => publicSessionPrompt(agentKey, targetSessionId, slug, promptsBySlug.get(slug) ?? null));
  }

  async getPrompt(session: ControlSessionRecord, agentKey: string, targetSessionId: string, slugInput: string): Promise<ControlSessionPromptRecord> {
    const slug = normalizeSessionPromptSlug(slugInput);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const prompt = await this.sessions.readSessionPrompt(targetSessionId, slug);
    return publicSessionPrompt(agentKey, targetSessionId, slug, prompt);
  }

  async setPrompt(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    slugInput: string,
    content: string,
    label: "prompt" | "briefing" = "prompt",
  ): Promise<{prompt: ControlSessionPromptRecord; audit: ControlBriefingMutationAudit}> {
    const slug = normalizeSessionPromptSlug(slugInput);
    const trimmed = content.trim();
    if (!trimmed) {
      throw emptyContentError(label);
    }
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const oldPrompt = await this.sessions.readSessionPrompt(targetSessionId, slug);
    const prompt = await this.sessions.setSessionPrompt({sessionId: targetSessionId, slug, content: trimmed});
    return {
      prompt: publicSessionPrompt(agentKey, targetSessionId, slug, prompt),
      audit: {
        action: "put",
        agentKey,
        targetSessionId,
        slug,
        old: summarizePrompt(oldPrompt),
        next: summarizePrompt(prompt),
      },
    };
  }

  async deletePrompt(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    slugInput: string,
  ): Promise<{prompt: ControlSessionPromptRecord; audit: ControlBriefingMutationAudit}> {
    const slug = normalizeSessionPromptSlug(slugInput);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const oldPrompt = await this.sessions.readSessionPrompt(targetSessionId, slug);
    await this.sessions.deleteSessionPrompt({sessionId: targetSessionId, slug});
    return {
      prompt: publicSessionPrompt(agentKey, targetSessionId, slug, null),
      audit: {
        action: "delete",
        agentKey,
        targetSessionId,
        slug,
        old: summarizePrompt(oldPrompt),
        next: {wasSet: false, length: 0, sha256: null},
      },
    };
  }

  async setBriefing(session: ControlSessionRecord, agentKey: string, targetSessionId: string, content: string): Promise<{briefing: ControlBriefingRecord; audit: ControlBriefingMutationAudit}> {
    const result = await this.setPrompt(session, agentKey, targetSessionId, SESSION_BRIEF_PROMPT_SLUG, content, "briefing");
    return {
      briefing: result.prompt as ControlBriefingRecord,
      audit: result.audit,
    };
  }

  async deleteBriefing(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<{briefing: ControlBriefingRecord; audit: ControlBriefingMutationAudit}> {
    const result = await this.deletePrompt(session, agentKey, targetSessionId, SESSION_BRIEF_PROMPT_SLUG);
    return {
      briefing: result.prompt as ControlBriefingRecord,
      audit: result.audit,
    };
  }
}
