import type {ThinkingLevel, ToolResultMessage} from "@earendil-works/pi-ai";
import {z} from "zod";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import {
  SUBAGENT_PROFILE_THINKING_LEVELS,
  type SubagentProfileRecord,
} from "../../domain/subagents/types.js";
import {
  SUBAGENT_TOOL_GROUP_KEYS,
  type SubagentToolGroup,
} from "../../domain/subagents/tool-groups.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {rethrowAsToolError} from "./shared.js";

const SUBAGENT_TOOL_GROUP_ENUM_VALUES = SUBAGENT_TOOL_GROUP_KEYS as unknown as [SubagentToolGroup, ...SubagentToolGroup[]];
const SUBAGENT_PROFILE_THINKING_ENUM_VALUES = SUBAGENT_PROFILE_THINKING_LEVELS as unknown as [ThinkingLevel, ...ThinkingLevel[]];

export type UpsertSubagentProfileToolStore = Pick<SubagentProfileStore, "upsertProfile">;

export interface UpsertSubagentProfileToolOptions {
  store: UpsertSubagentProfileToolStore;
}

function readRequiredAgentKey(context: unknown): string {
  const agentKey = isRecord(context) ? trimToUndefined(context.agentKey) : undefined;
  if (!agentKey) {
    throw new ToolError("upsert_subagent_profile requires agentKey in the runtime session context.");
  }
  return agentKey;
}

function serializeProfile(profile: SubagentProfileRecord): JsonObject {
  return {
    slug: profile.slug,
    source: profile.source,
    ...(profile.agentKey !== undefined ? {agentKey: profile.agentKey} : {}),
    description: profile.description,
    toolGroups: [...profile.toolGroups],
    ...(profile.model !== undefined ? {model: profile.model} : {}),
    ...(profile.thinking !== undefined ? {thinking: profile.thinking} : {}),
    enabled: profile.enabled,
  };
}

export class UpsertSubagentProfileTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof UpsertSubagentProfileTool.schema, TContext> {
  static schema = z.object({
    slug: z.string().trim().min(1).describe("Agent-scoped custom subagent profile slug to create or update."),
    description: z.string().trim().min(1).max(255).describe("Short profile description shown to agents."),
    prompt: z.string().trim().min(1).describe("System prompt/instructions for subagents spawned with this profile."),
    toolGroups: z.array(z.enum(SUBAGENT_TOOL_GROUP_ENUM_VALUES)).min(1).max(20).describe("Subagent tool groups granted by this profile."),
    model: z.string().trim().min(1).optional().describe("Optional model override for subagents spawned with this profile."),
    thinking: z.enum(SUBAGENT_PROFILE_THINKING_ENUM_VALUES).optional().describe("Optional thinking level for subagents spawned with this profile."),
    enabled: z.boolean().optional().describe("Whether the profile is available for spawn_subagent. Defaults to true."),
  }).strict();

  name = "upsert_subagent_profile";
  description = [
    "Create or update a custom subagent profile scoped to the current agent.",
    "Profiles store only prompt, description, toolGroups, optional model/thinking, and enabled state.",
    "Credentials, environments, execution mode, raw tool allowlists, skill allowlists, and other spawn-time fields are not accepted.",
  ].join("\n");
  schema = UpsertSubagentProfileTool.schema;

  private readonly store: UpsertSubagentProfileToolStore;

  constructor(options: UpsertSubagentProfileToolOptions) {
    super();
    this.store = options.store;
  }

  override formatCall(args: Record<string, unknown>): string {
    const slug = typeof args.slug === "string" ? args.slug : "profile";
    return slug;
  }

  override formatResult(message: ToolResultMessage): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return message.isError ? "Subagent profile upsert failed." : "Subagent profile upserted.";
    }

    const slug = typeof details.slug === "string" ? details.slug : undefined;
    const agentKey = typeof details.agentKey === "string" ? details.agentKey : undefined;
    return [
      "subagent profile upserted",
      slug ? `slug ${slug}` : "",
      agentKey ? `agent ${agentKey}` : "",
    ].filter(Boolean).join("\n");
  }

  async handle(
    args: z.output<typeof UpsertSubagentProfileTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const agentKey = readRequiredAgentKey(run.context);

    const profile = await this.store.upsertProfile({
      slug: args.slug,
      description: args.description,
      prompt: args.prompt,
      toolGroups: args.toolGroups,
      ...(args.model !== undefined ? {model: args.model} : {}),
      ...(args.thinking !== undefined ? {thinking: args.thinking} : {}),
      ...(args.enabled !== undefined ? {enabled: args.enabled} : {}),
      source: "custom",
      agentKey,
      createdByAgentKey: agentKey,
      transcriptMode: "none",
    }).catch((error: unknown) => rethrowAsToolError(error));

    return serializeProfile(profile);
  }
}
