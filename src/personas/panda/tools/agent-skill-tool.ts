import {z} from "zod";

import {Tool} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {PandaSessionContext} from "../types.js";
import type {AgentStore} from "../../../domain/agents/store.js";
import {
    MAX_AGENT_SKILL_CONTENT_CHARS,
    MAX_AGENT_SKILL_DESCRIPTION_CHARS,
    normalizeAgentSkillContent,
    normalizeAgentSkillDescription,
} from "../../../domain/agents/types.js";

function readAgentSkillScope(context: unknown): { agentKey: string } {
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as {agentKey?: unknown}).agentKey !== "string"
    || !(context as {agentKey: string}).agentKey.trim()
  ) {
    throw new ToolError("The agent skill tool requires agentKey in the Panda session context.");
  }

  return {
    agentKey: (context as {agentKey: string}).agentKey,
  };
}

export interface AgentSkillToolOptions {
  store: AgentStore;
}

function issueMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentSkillTool<TContext = PandaSessionContext>
  extends Tool<typeof AgentSkillTool.schema, TContext> {
  static schema = z.object({
    operation: z.enum(["set", "delete"]).describe("Create or replace a skill, or delete it by key."),
    skillKey: z.string().trim().min(1).describe("Stable slug-style skill key, for example calendar or trip_planner."),
    description: z.string().optional().describe(
      `Required for set. Short summary injected into the normal Panda workspace. Max ${MAX_AGENT_SKILL_DESCRIPTION_CHARS} characters.`,
    ),
    content: z.string().optional().describe(
      `Required for set. Full markdown skill body stored in Postgres. Max ${MAX_AGENT_SKILL_CONTENT_CHARS} characters.`,
    ),
  }).superRefine((value, ctx) => {
    if (value.operation === "set") {
      if (value.description === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Set requires description." });
      } else {
        try {
          normalizeAgentSkillDescription(value.description);
        } catch (error) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: issueMessage(error) });
        }
      }
      if (value.content === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Set requires content." });
      } else {
        try {
          normalizeAgentSkillContent(value.content);
        } catch (error) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: issueMessage(error) });
        }
      }
      return;
    }

    if (value.description !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Delete does not take description." });
    }
    if (value.content !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Delete does not take content." });
    }
  });

  name = "agent_skill";
  description =
    "Create, replace, or delete agent-scoped skills stored in Postgres. When the user gives you a skill body to save, pass that body through unchanged unless they explicitly asked you to rewrite it; only derive the short description when needed. Normal Panda runs only inject each skill's key and description.";
  schema = AgentSkillTool.schema;

  private readonly store: AgentStore;

  constructor(options: AgentSkillToolOptions) {
    super();
    this.store = options.store;
  }

  override formatCall(args: Record<string, unknown>): string {
    const operation = typeof args.operation === "string" ? args.operation : "set";
    const skillKey = typeof args.skillKey === "string" ? args.skillKey : "skill";
    return `${operation} ${skillKey}`;
  }

  async handle(
    args: z.output<typeof AgentSkillTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{
      operation: "set" | "delete";
      agentKey: string;
      skillKey: string;
      description?: string;
      contentBytes?: number;
      deleted?: boolean;
    }> {
    const scope = readAgentSkillScope(run.context);

    if (args.operation === "delete") {
      return {
        operation: "delete",
        agentKey: scope.agentKey,
        skillKey: args.skillKey,
        deleted: await this.store.deleteAgentSkill(scope.agentKey, args.skillKey),
      };
    }

    const record = await this.store.setAgentSkill(
      scope.agentKey,
      args.skillKey,
      normalizeAgentSkillDescription(args.description ?? ""),
      normalizeAgentSkillContent(args.content ?? ""),
    );

    return {
      operation: "set",
      agentKey: scope.agentKey,
      skillKey: record.skillKey,
      description: record.description,
      contentBytes: Buffer.byteLength(record.content, "utf8"),
    };
  }
}
