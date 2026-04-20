import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {AgentStore} from "../../domain/agents/store.js";
import type {AgentPromptRecord, AgentPromptSlug} from "../../domain/agents/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {isRecord} from "../../lib/records.js";
import {buildJsonToolPayload} from "./shared.js";

const AGENT_PROMPT_SLUGS = ["agent", "heartbeat"] as const;
const WHITELISTED_FUNCTIONS = new Set([
  "regexp_replace",
  "replace",
  "overlay",
  "trim",
  "ltrim",
  "rtrim",
  "upper",
  "lower",
  "left",
  "right",
  "substring",
  "concat",
  "coalesce",
  "length",
]);
const WHITELISTED_IDENTIFIERS = new Set([
  "content",
  "placing",
  "from",
  "for",
  "null",
]);

type AgentPromptToolOperation = "read" | "set" | "transform";

interface AgentPromptToolScope {
  agentKey: string;
}

interface Token {
  type: "identifier" | "number" | "string" | "symbol";
  value: string;
}

function readScope(context: unknown): AgentPromptToolScope {
  if (!isRecord(context) || typeof context.agentKey !== "string" || !context.agentKey.trim()) {
    throw new ToolError("The agent prompt tool requires agentKey in the runtime session context.");
  }

  return {
    agentKey: context.agentKey,
  };
}

function tokenizeExpression(expression: string): Token[] {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new ToolError("Transform expression must not be empty.");
  }
  if (
    trimmed.includes(";")
    || trimmed.includes("--")
    || trimmed.includes("/*")
    || trimmed.includes("*/")
    || trimmed.includes("\"")
  ) {
    throw new ToolError("Transform expression uses unsupported SQL syntax.");
  }

  const tokens: Token[] = [];
  let index = 0;

  while (index < trimmed.length) {
    const char = trimmed[index];
    if (!char) {
      break;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "'") {
      let cursor = index + 1;
      let value = "'";
      let closed = false;
      while (cursor < trimmed.length) {
        const next = trimmed[cursor];
        if (!next) {
          break;
        }

        value += next;
        cursor += 1;
        if (next === "'") {
          if (trimmed[cursor] === "'") {
            value += "'";
            cursor += 1;
            continue;
          }

          closed = true;
          break;
        }
      }

      if (!closed) {
        throw new ToolError("Transform expression has an unterminated string literal.");
      }

      tokens.push({type: "string", value});
      index = cursor;
      continue;
    }

    if (/\d/.test(char)) {
      let cursor = index + 1;
      while (cursor < trimmed.length && /\d/.test(trimmed[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({
        type: "number",
        value: trimmed.slice(index, cursor),
      });
      index = cursor;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let cursor = index + 1;
      while (cursor < trimmed.length && /[A-Za-z0-9_]/.test(trimmed[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({
        type: "identifier",
        value: trimmed.slice(index, cursor),
      });
      index = cursor;
      continue;
    }

    if (char === "|" && trimmed[index + 1] === "|") {
      tokens.push({type: "symbol", value: "||"});
      index += 2;
      continue;
    }

    if ("(),+-*/".includes(char)) {
      tokens.push({type: "symbol", value: char});
      index += 1;
      continue;
    }

    throw new ToolError(`Unsupported transform expression token: ${char}`);
  }

  return tokens;
}

function validateTransformExpression(expression: string): string {
  const tokens = tokenizeExpression(expression);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "identifier") {
      continue;
    }

    const normalized = token.value.toLowerCase();
    const next = tokens[index + 1];
    const isFunctionCall = next?.type === "symbol" && next.value === "(";

    if (isFunctionCall) {
      if (!WHITELISTED_FUNCTIONS.has(normalized)) {
        throw new ToolError(`Transform expression uses unsupported function ${token.value}.`);
      }
      continue;
    }

    if (!WHITELISTED_IDENTIFIERS.has(normalized)) {
      throw new ToolError(`Transform expression uses unsupported identifier ${token.value}.`);
    }
  }

  return expression.trim();
}

function buildPromptPayload(
  scope: AgentPromptToolScope,
  slug: AgentPromptSlug,
  operation: AgentPromptToolOperation,
  record: AgentPromptRecord | null,
): ReturnType<typeof buildJsonToolPayload> {
  const details = {
    agentKey: scope.agentKey,
    slug,
    operation,
    exists: record !== null,
    content: record?.content ?? "",
    ...(record ? {updatedAt: record.updatedAt} : {}),
  };

  return buildJsonToolPayload(details);
}

export interface AgentPromptToolOptions {
  store: AgentStore;
}

export class AgentPromptTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AgentPromptTool.schema, TContext> {
  private static readonly transformGuide = [
    "Safe SQL-ish text editing over content.",
    "Allowed functions: regexp_replace, replace, overlay, trim, ltrim, rtrim, upper, lower, left, right, substring, concat, coalesce, length.",
    "Useful patterns:",
    "- append: content || '\\n- new line'",
    "- prepend: 'header\\n' || content",
    "- delete exact text: replace(content, 'exact line\\n', '')",
    "- regex delete/update: regexp_replace(content, 'pattern.*\\n', '', 'g')",
    "- update in place: replace(content, 'old', 'new')",
    "- insert after anchor: replace(content, 'anchor line', 'anchor line\\nnew line')",
    "- trim whitespace: trim(content)",
    "- extract substring: substring(content from 1 for 50)",
  ].join("\n");

  static schema = z.object({
    slug: z.enum(AGENT_PROMPT_SLUGS).describe(
      "Which shared agent prompt to work with. Supported slugs are agent and heartbeat.",
    ),
    operation: z.enum(["read", "set", "transform"]).describe(
      "Read the current content, replace it, or transform it with a safe SQL-ish text expression.",
    ),
    content: z.string().optional().describe("Required for set. Replaces the whole prompt content."),
    expression: z.string().optional().describe(
      `Required for transform. Uses a restricted SQL-ish expression over the current content value.\n${AgentPromptTool.transformGuide}`,
    ),
  }).superRefine((value, ctx) => {
    if (value.operation === "read") {
      if (value.content !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Read does not take content."});
      }
      if (value.expression !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Read does not take expression."});
      }
    }

    if (value.operation === "set" && value.content === undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Set requires content."});
    }
    if (value.operation === "set" && value.expression !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Set does not take expression."});
    }

    if (value.operation === "transform" && value.expression === undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Transform requires expression."});
    }
    if (value.operation === "transform" && value.content !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Transform does not take content."});
    }
  });

  name = "agent_prompt";
  description = [
    "Read or update shared agent prompts.",
    "The tool always uses the current session's agent.",
    AgentPromptTool.transformGuide,
  ].join("\n\n");
  schema = AgentPromptTool.schema;

  private readonly store: AgentStore;

  constructor(options: AgentPromptToolOptions) {
    super();
    this.store = options.store;
  }

  override formatCall(args: Record<string, unknown>): string {
    const operation = typeof args.operation === "string" ? args.operation : "read";
    const slug = typeof args.slug === "string" ? args.slug : "prompt";
    return `${operation} ${slug}`;
  }

  async handle(
    args: z.output<typeof AgentPromptTool.schema>,
    run: RunContext<TContext>,
  ) {
    const scope = readScope(run.context);

    if (args.operation === "read") {
      return buildPromptPayload(
        scope,
        args.slug,
        args.operation,
        await this.store.readAgentPrompt(scope.agentKey, args.slug),
      );
    }

    if (args.operation === "set") {
      return buildPromptPayload(
        scope,
        args.slug,
        args.operation,
        await this.store.setAgentPrompt(scope.agentKey, args.slug, args.content ?? ""),
      );
    }

    return buildPromptPayload(
      scope,
      args.slug,
      args.operation,
      await this.store.transformAgentPrompt(
        scope.agentKey,
        args.slug,
        validateTransformExpression(args.expression ?? ""),
      ),
    );
  }
}
