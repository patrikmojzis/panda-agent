import {z} from "zod";

import {Tool} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {JsonObject, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import {CredentialService} from "../../../domain/credentials/index.js";
import type {PandaSessionContext} from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildPayload(details: JsonObject): ToolResultPayload {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(details, null, 2),
    }],
    details,
  };
}

function readScope(context: unknown): { agentKey: string; identityId: string } {
  if (
    !isRecord(context)
    || typeof context.agentKey !== "string"
    || !context.agentKey.trim()
    || typeof context.identityId !== "string"
    || !context.identityId.trim()
  ) {
    throw new ToolError(
      "Credential tools require both agentKey and identityId in the current Panda thread context.",
    );
  }

  return {
    agentKey: context.agentKey,
    identityId: context.identityId,
  };
}

export interface EnvValueToolOptions {
  service: CredentialService;
}

export class SetEnvValueTool<TContext = PandaSessionContext> extends Tool<typeof SetEnvValueTool.schema, TContext> {
  static schema = z.object({
    key: z.string().trim().min(1).describe("Shell env key to store."),
    value: z.string().describe("Secret value to persist."),
    scope: z.enum(["relationship", "agent"]).optional().describe(
      "Omit for relationship. Use agent for service-account style credentials shared across identities.",
    ),
  });

  name = "set_env_value";
  description = [
    "Persist a secret env value for future bash calls.",
    "Default scope is the current relationship (identity + agent).",
    "Use scope=agent only when the credential belongs to the agent itself.",
  ].join("\n");
  schema = SetEnvValueTool.schema;

  private readonly service: CredentialService;

  constructor(options: EnvValueToolOptions) {
    super();
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    const key = typeof args.key === "string" ? args.key : "ENV_KEY";
    const scope = typeof args.scope === "string" ? args.scope : "relationship";
    return `${scope}:${key}`;
  }

  override redactCallArguments(args: Record<string, unknown>): Record<string, unknown> {
    if (typeof args.value !== "string") {
      return args;
    }

    return {
      ...args,
      value: "[redacted]",
    };
  }

  async handle(
    args: z.output<typeof SetEnvValueTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const {agentKey, identityId} = readScope(run.context);
    const scope = args.scope ?? "relationship";
    const record = await this.service.setCredential({
      envKey: args.key,
      value: args.value,
      scope,
      agentKey,
      ...(scope === "relationship" ? {identityId} : {}),
    });
    const resolvedAgentKey = record.agentKey ?? agentKey;

    return buildPayload({
      ok: true,
      action: "set",
      envKey: record.envKey,
      scope: record.scope,
      agentKey: resolvedAgentKey,
      ...(record.identityId ? {identityId: record.identityId} : {}),
      updatedAt: record.updatedAt,
    });
  }
}

export class ClearEnvValueTool<TContext = PandaSessionContext> extends Tool<typeof ClearEnvValueTool.schema, TContext> {
  static schema = z.object({
    key: z.string().trim().min(1).describe("Shell env key to clear."),
    scope: z.enum(["relationship", "agent"]).optional().describe(
      "Omit for relationship. Use agent to clear an agent-owned credential.",
    ),
  });

  name = "clear_env_value";
  description = [
    "Delete a stored secret env value.",
    "Default scope is the current relationship (identity + agent).",
  ].join("\n");
  schema = ClearEnvValueTool.schema;

  private readonly service: CredentialService;

  constructor(options: EnvValueToolOptions) {
    super();
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    const key = typeof args.key === "string" ? args.key : "ENV_KEY";
    const scope = typeof args.scope === "string" ? args.scope : "relationship";
    return `${scope}:${key}`;
  }

  async handle(
    args: z.output<typeof ClearEnvValueTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const {agentKey, identityId} = readScope(run.context);
    const scope = args.scope ?? "relationship";
    const deleted = await this.service.clearCredential({
      envKey: args.key,
      scope,
      agentKey,
      ...(scope === "relationship" ? {identityId} : {}),
    });

    return buildPayload({
      ok: true,
      action: "clear",
      envKey: args.key,
      scope,
      agentKey,
      ...(scope === "relationship" ? {identityId} : {}),
      deleted,
    });
  }
}
