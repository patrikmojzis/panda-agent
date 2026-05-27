import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {RunContext} from "../../kernel/agent/run-context.js";
import type {ExecutionEnvironmentRecord} from "../../domain/execution-environments/types.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import {
  readSubagentSessionMetadata,
  type SubagentExecutionMode,
} from "../../domain/subagents/session-metadata.js";
import {
  SUBAGENT_TOOL_GROUP_KEYS,
  type SubagentToolGroup,
} from "../../domain/subagents/tool-groups.js";
import type {ThreadRecord} from "../../domain/threads/runtime/types.js";
import type {JsonObject} from "../../lib/json.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {readRequiredAgentSessionToolScope, rethrowAsToolError} from "./shared.js";

const SUBAGENT_EXECUTION_MODES = ["agent_workspace", "isolated_environment"] as const;
const SUBAGENT_TOOL_GROUP_ENUM_VALUES = SUBAGENT_TOOL_GROUP_KEYS as unknown as [SubagentToolGroup, ...SubagentToolGroup[]];

export interface SubagentSessionCreator {
  createSubagentSession(input: {
    agentKey: string;
    parentSessionId: string;
    task: string;
    context?: string;
    profile?: string;
    toolGroups?: readonly SubagentToolGroup[];
    execution?: SubagentExecutionMode;
    environmentId?: string;
    credentialAllowlist?: readonly string[];
    createdByIdentityId?: string;
  }): Promise<{
    session: Pick<SessionRecord, "id" | "metadata">;
    thread: Pick<ThreadRecord, "id">;
    environment?: Pick<ExecutionEnvironmentRecord, "id">;
  }>;
}

export interface SpawnSubagentToolOptions {
  subagentSessions: SubagentSessionCreator;
}

export class SpawnSubagentTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof SpawnSubagentTool.schema, TContext> {
  static schema = z.object({
    prompt: z.string().trim().min(1).describe("The concrete handoff prompt for the durable subagent session."),
    profile: z.string().trim().min(1).optional().describe("Optional subagent profile slug. Omit when using ad-hoc toolGroups."),
    context: z.string().trim().min(1).optional().describe("Optional extra context for the subagent."),
    execution: z.enum(SUBAGENT_EXECUTION_MODES).optional().describe("Execution mode. Defaults to agent_workspace. isolated_environment requires environmentId."),
    environmentId: z.string().trim().min(1).optional().describe("Existing ready parent-owned disposable environment id for isolated_environment only."),
    credentialAllowlist: z.array(z.string().trim().min(1)).max(50).optional().describe("Explicit credential env keys the subagent may receive. Defaults to none."),
    toolGroups: z.array(z.enum(SUBAGENT_TOOL_GROUP_ENUM_VALUES)).min(1).max(20).optional().describe("Ad-hoc tool groups to use when profile is omitted."),
  }).strict();

  name = "spawn_subagent";
  description = [
    "Create a durable subagent session and hand off work immediately.",
    "Subagents do not inherit the parent transcript; include all necessary task context in prompt/context.",
    "Progress and completion come back through A2A message_agent from the subagent, not background-job polling.",
    "Use environment_create first if isolated_environment needs a disposable environment; spawn_subagent only attaches to an existing ready environment owned by this parent session.",
  ].join("\n");
  schema = SpawnSubagentTool.schema;

  private readonly subagentSessions: SubagentSessionCreator;

  constructor(options: SpawnSubagentToolOptions) {
    super();
    this.subagentSessions = options.subagentSessions;
  }

  override formatCall(args: Record<string, unknown>): string {
    const profile = typeof args.profile === "string" ? args.profile : "subagent";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    return `${profile}: ${prompt}`.trim();
  }

  override formatResult(message: ToolResultMessage): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return message.isError ? "Subagent spawn failed." : "Subagent spawned.";
    }

    const sessionId = typeof details.sessionId === "string" ? details.sessionId : undefined;
    const threadId = typeof details.threadId === "string" ? details.threadId : undefined;
    const profile = typeof details.profile === "string" ? details.profile : undefined;
    const execution = typeof details.execution === "string" ? details.execution : undefined;
    return [
      "subagent spawned",
      sessionId ? `session ${sessionId}` : "",
      threadId ? `thread ${threadId}` : "",
      profile ? `profile ${profile}` : "",
      execution ? `execution ${execution}` : "",
    ].filter(Boolean).join("\n");
  }

  async handle(
    args: z.output<typeof SpawnSubagentTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const scope = readRequiredAgentSessionToolScope(
      run.context,
      "spawn_subagent requires agentKey and sessionId in the runtime session context.",
    );

    const created = await this.subagentSessions.createSubagentSession({
      agentKey: scope.agentKey,
      parentSessionId: scope.sessionId,
      task: args.prompt,
      ...(args.context !== undefined ? {context: args.context} : {}),
      ...(args.profile !== undefined ? {profile: args.profile} : {}),
      ...(args.toolGroups !== undefined ? {toolGroups: args.toolGroups} : {}),
      ...(args.execution !== undefined ? {execution: args.execution} : {}),
      ...(args.environmentId !== undefined ? {environmentId: args.environmentId} : {}),
      credentialAllowlist: args.credentialAllowlist ?? [],
      ...(scope.identityId ? {createdByIdentityId: scope.identityId} : {}),
    }).catch((error: unknown) => rethrowAsToolError(error));

    const metadata = readSubagentSessionMetadata(created.session.metadata);
    if (!metadata) {
      throw new ToolError("Subagent session service returned a session without subagent metadata.");
    }

    return {
      status: "spawned",
      sessionId: created.session.id,
      threadId: created.thread.id,
      profile: metadata.profile.slug,
      profileSource: metadata.profile.source,
      execution: metadata.execution,
      ...(created.environment?.id ? {environmentId: created.environment.id} : {}),
      note: "Progress and completion will arrive through A2A message_agent, not a background job.",
    };
  }
}
