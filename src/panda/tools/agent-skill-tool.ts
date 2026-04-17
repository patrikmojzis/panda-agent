import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {
  MAX_AGENT_SKILL_CONTENT_CHARS,
  MAX_AGENT_SKILL_DESCRIPTION_CHARS,
  normalizeAgentSkillContent,
  normalizeAgentSkillDescription,
} from "../../domain/agents/types.js";

function readAgentSkillScope(context: unknown): { agentKey: string } {
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as {agentKey?: unknown}).agentKey !== "string"
    || !(context as {agentKey: string}).agentKey.trim()
  ) {
    throw new ToolError("The agent skill tool requires agentKey in the runtime session context.");
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

type AgentSkillToolResult =
  | {
    operation: "load";
    agentKey: string;
    skillKey: string;
    found: false;
  }
  | {
    operation: "load";
    agentKey: string;
    skillKey: string;
    found: true;
    description: string;
    content: string;
    contentBytes: number;
    loadCount: number;
    lastLoadedAt?: number;
  }
  | {
    operation: "set";
    agentKey: string;
    skillKey: string;
    description: string;
    contentBytes: number;
  }
  | {
    operation: "delete";
    agentKey: string;
    skillKey: string;
    deleted: boolean;
  };

export class AgentSkillTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AgentSkillTool.schema, TContext> {
  static schema = z.object({
    operation: z.enum(["load", "set", "delete"]).describe(
      "Load a full skill body into context, create or replace a skill, or delete it by key.",
    ),
    skillKey: z.string().trim().min(1).describe("Stable slug-style skill key, for example calendar or trip_planner."),
    description: z.string().optional().describe(
      `Required for set. Short summary injected into the standard agent context. Max ${MAX_AGENT_SKILL_DESCRIPTION_CHARS} characters.`,
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
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.operation === "load" ? "Load" : "Delete"} does not take description.`,
      });
    }
    if (value.content !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.operation === "load" ? "Load" : "Delete"} does not take content.`,
      });
    }
  });

  name = "agent_skill";
  description =
    "Load, create, replace, or delete agent-scoped skills stored in Postgres. Use load when an injected skill summary looks relevant and you need the full markdown body in context. When the user gives you a skill body to save, pass that body through unchanged unless they explicitly asked you to rewrite it; only derive the short description when needed. Normal agent runs only inject each skill's key and description. For post-run reflective learning, prefer the skill_maintainer subagent instead of writing reflective skills directly from the main agent.";
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
  ): Promise<AgentSkillToolResult> {
    const scope = readAgentSkillScope(run.context);

    if (args.operation === "load") {
      const record = await this.store.loadAgentSkill(scope.agentKey, args.skillKey);
      if (!record) {
        return {
          operation: "load",
          agentKey: scope.agentKey,
          skillKey: args.skillKey,
          found: false,
        };
      }

      return {
        operation: "load",
        agentKey: scope.agentKey,
        skillKey: record.skillKey,
        found: true,
        description: record.description,
        content: record.content,
        contentBytes: Buffer.byteLength(record.content, "utf8"),
        loadCount: record.loadCount,
        lastLoadedAt: record.lastLoadedAt,
      };
    }

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
