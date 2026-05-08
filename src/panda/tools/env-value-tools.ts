import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {CredentialService} from "../../domain/credentials/index.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {buildJsonToolPayload, rethrowAsToolError} from "./shared.js";

function readAgentKey(context: unknown): string {
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new ToolError(
      "Credential tools require agentKey in the current runtime session context.",
    );
  }

  const record = context as Record<string, unknown>;
  const agentKey = typeof record.agentKey === "string" ? record.agentKey.trim() : "";
  if (!agentKey) {
    throw new ToolError(
      "Credential tools require agentKey in the current runtime session context.",
    );
  }

  return agentKey;
}

function assertCredentialMutationAllowed(context: unknown): void {
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    return;
  }

  const environment = (context as Record<string, unknown>).executionEnvironment;
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    return;
  }

  const record = environment as Record<string, unknown>;
  const credentialPolicy = record.credentialPolicy;
  const policyMode = typeof credentialPolicy === "object" && credentialPolicy !== null && !Array.isArray(credentialPolicy)
    ? (credentialPolicy as Record<string, unknown>).mode
    : undefined;
  if (record.kind === "disposable_container" || policyMode === "none" || policyMode === "allowlist") {
    throw new ToolError("Credential mutation is not allowed in this execution environment.");
  }
}

export interface EnvValueToolOptions {
  service: CredentialService;
}

export class SetEnvValueTool<TContext = DefaultAgentSessionContext> extends Tool<typeof SetEnvValueTool.schema, TContext> {
  static schema = z.object({
    key: z.string().trim().min(1).describe("Shell env key to store."),
    value: z.string().describe("Secret value to persist."),
  });

  name = "set_env_value";
  description = [
    "Persist a secret env value for future bash calls.",
    "Stored values belong to the current agent.",
  ].join("\n");
  schema = SetEnvValueTool.schema;

  private readonly service: CredentialService;

  constructor(options: EnvValueToolOptions) {
    super();
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    const key = typeof args.key === "string" ? args.key : "ENV_KEY";
    return key;
  }

  async handle(
    args: z.output<typeof SetEnvValueTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    assertCredentialMutationAllowed(run.context);
    const agentKey = readAgentKey(run.context);

    const record = await this.service.setCredential({
      envKey: args.key,
      value: args.value,
      agentKey,
    }).catch((error: unknown) => rethrowAsToolError(error));

    return buildJsonToolPayload({
      ok: true,
      envKey: record.envKey,
      valueLength: record.value.length,
    });
  }
}

export class ClearEnvValueTool<TContext = DefaultAgentSessionContext> extends Tool<typeof ClearEnvValueTool.schema, TContext> {
  static schema = z.object({
    key: z.string().trim().min(1).describe("Shell env key to clear."),
  });

  name = "clear_env_value";
  description = [
    "Delete a stored secret env value.",
    "Stored values belong to the current agent.",
  ].join("\n");
  schema = ClearEnvValueTool.schema;

  private readonly service: CredentialService;

  constructor(options: EnvValueToolOptions) {
    super();
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    const key = typeof args.key === "string" ? args.key : "ENV_KEY";
    return key;
  }

  async handle(
    args: z.output<typeof ClearEnvValueTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    assertCredentialMutationAllowed(run.context);
    const agentKey = readAgentKey(run.context);

    const deleted = await this.service.clearCredential({
      envKey: args.key,
      agentKey,
    }).catch((error: unknown) => rethrowAsToolError(error));

    return buildJsonToolPayload({
      ok: true,
      action: "clear",
      envKey: args.key,
      agentKey,
      deleted,
    });
  }
}
