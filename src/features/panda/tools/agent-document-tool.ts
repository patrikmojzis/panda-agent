import {z} from "zod";

import {Tool} from "../../agent-core/tool.js";
import {ToolError} from "../../agent-core/exceptions.js";
import type {JsonObject, ToolResultPayload} from "../../agent-core/types.js";
import type {RunContext} from "../../agent-core/run-context.js";
import type {AgentStore} from "../../agents/store.js";
import {resolveDateTimeContextOptions} from "../contexts/datetime-context.js";
import type {
    AgentDiaryRecord,
    AgentDocumentRecord,
    AgentDocumentSlug,
    RelationshipDocumentRecord,
    RelationshipDocumentSlug,
} from "../../agents/types.js";
import type {PandaSessionContext} from "../types.js";

const AGENT_DOCUMENT_SLUGS = ["agent", "soul", "heartbeat", "playbook"] as const;
const RELATIONSHIP_DOCUMENT_SLUGS = ["memory"] as const;
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

type AgentDocumentToolTarget = "agent" | "relationship" | "diary";
type AgentDocumentToolOperation = "read" | "set" | "transform";

interface Scope {
  identityId: string;
  agentKey: string;
  timezone: string;
}

interface Token {
  type: "identifier" | "number" | "string" | "symbol";
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScope(context: unknown): Scope {
  if (
    !isRecord(context)
    || typeof context.identityId !== "string"
    || !context.identityId.trim()
    || typeof context.agentKey !== "string"
    || !context.agentKey.trim()
  ) {
    throw new ToolError(
      "The agent document tool requires both identityId and agentKey in the persisted Panda thread context.",
    );
  }

  return {
    identityId: context.identityId,
    agentKey: context.agentKey,
    timezone: resolveDateTimeContextOptions({
      timeZone: typeof context.timezone === "string" && context.timezone.trim()
        ? context.timezone
        : undefined,
    }).timeZone,
  };
}

function formatLocalDate(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new ToolError(`Failed to resolve local date for timezone ${timeZone}.`);
  }

  return `${year}-${month}-${day}`;
}

function normalizeDiaryDate(value: string | undefined, timeZone: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return formatLocalDate(timeZone);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ToolError("Diary date must use YYYY-MM-DD.");
  }

  return trimmed;
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

      tokens.push({ type: "string", value });
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
      tokens.push({ type: "symbol", value: "||" });
      index += 2;
      continue;
    }

    if ("(),+-*/".includes(char)) {
      tokens.push({ type: "symbol", value: char });
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

function buildPayload(details: JsonObject): ToolResultPayload {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(details, null, 2),
    }],
    details,
  };
}

function slugForTarget(target: AgentDocumentToolTarget, slug: string | undefined): AgentDocumentSlug | RelationshipDocumentSlug | undefined {
  if (target === "agent") {
    if (!slug || !AGENT_DOCUMENT_SLUGS.includes(slug as AgentDocumentSlug)) {
      throw new ToolError(`Agent target requires one of: ${AGENT_DOCUMENT_SLUGS.join(", ")}.`);
    }

    return slug as AgentDocumentSlug;
  }

  if (target === "relationship") {
    if (!slug || !RELATIONSHIP_DOCUMENT_SLUGS.includes(slug as RelationshipDocumentSlug)) {
      throw new ToolError(`Relationship target requires one of: ${RELATIONSHIP_DOCUMENT_SLUGS.join(", ")}.`);
    }

    return slug as RelationshipDocumentSlug;
  }

  if (slug) {
    throw new ToolError("Diary target does not take a slug.");
  }

  return undefined;
}

function recordPayload(
  scope: Scope,
  target: AgentDocumentToolTarget,
  operation: AgentDocumentToolOperation,
  record: AgentDocumentRecord | RelationshipDocumentRecord | AgentDiaryRecord | null,
  extra: { slug?: string; date?: string; exists?: boolean } = {},
): ToolResultPayload {
  const details: JsonObject = {
    target,
    operation,
    agentKey: scope.agentKey,
    exists: extra.exists ?? Boolean(record),
    content: record?.content ?? "",
  };
  if (target !== "agent") {
    details.identityId = scope.identityId;
  }
  if (extra.slug !== undefined) {
    details.slug = extra.slug;
  }
  if (extra.date !== undefined) {
    details.date = extra.date;
  }
  if (record?.updatedAt !== undefined) {
    details.updatedAt = record.updatedAt;
  }

  return buildPayload(details);
}

export interface AgentDocumentToolOptions {
  store: AgentStore;
}

export class AgentDocumentTool<TContext = PandaSessionContext>
  extends Tool<typeof AgentDocumentTool.schema, TContext> {
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
    target: z.enum(["agent", "relationship", "diary"]).describe(
      "Which document scope to work with: shared agent docs, relationship memory, or the daily diary.",
    ),
    slug: z.string().trim().optional().describe(
      "Required for agent and relationship targets. Agent supports agent, soul, heartbeat, playbook. Relationship supports memory.",
    ),
    operation: z.enum(["read", "set", "transform"]).describe("Read the current content, replace it, or transform it with a safe SQL-ish text expression."),
    content: z.string().optional().describe("Required for set. Replaces the whole document content."),
    expression: z.string().optional().describe(
      `Required for transform. Uses a restricted SQL-ish expression over the current content value.\n${AgentDocumentTool.transformGuide}`,
    ),
    date: z.string().trim().optional().describe("Only for diary. Defaults to the current thread-local day in YYYY-MM-DD."),
  }).superRefine((value, ctx) => {
    try {
      slugForTarget(value.target, value.slug);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid target/slug combination.",
      });
    }

    if (value.operation === "read") {
      if (value.content !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Read does not take content." });
      }
      if (value.expression !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Read does not take expression." });
      }
    }

    if (value.operation === "set" && value.content === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Set requires content." });
    }
    if (value.operation === "set" && value.expression !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Set does not take expression." });
    }

    if (value.operation === "transform" && value.expression === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Transform requires expression." });
    }
    if (value.operation === "transform" && value.content !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Transform does not take content." });
    }
  });

  name = "agent_document";
  description = [
    "Read or update shared agent docs, relationship memory, or a relationship diary entry.",
    "The tool always uses the current thread's agent and identity.",
    AgentDocumentTool.transformGuide,
  ].join("\n\n");
  schema = AgentDocumentTool.schema;

  private readonly store: AgentStore;

  constructor(options: AgentDocumentToolOptions) {
    super();
    this.store = options.store;
  }

  override formatCall(args: Record<string, unknown>): string {
    const target = typeof args.target === "string" ? args.target : "document";
    const operation = typeof args.operation === "string" ? args.operation : "read";
    const slug = typeof args.slug === "string" ? `:${args.slug}` : "";
    const date = typeof args.date === "string" ? `@${args.date}` : "";
    return `${operation} ${target}${slug}${date}`;
  }

  async handle(
    args: z.output<typeof AgentDocumentTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const scope = readScope(run.context);
    const slug = slugForTarget(args.target, args.slug);

    switch (args.target) {
      case "agent":
        return this.handleAgentDocument(scope, args.operation, slug as AgentDocumentSlug, args.content, args.expression);
      case "relationship":
        return this.handleRelationshipDocument(
          scope,
          args.operation,
          slug as RelationshipDocumentSlug,
          args.content,
          args.expression,
        );
      case "diary":
        return this.handleDiary(scope, args.operation, normalizeDiaryDate(args.date, scope.timezone), args.content, args.expression);
    }
  }

  private async handleAgentDocument(
    scope: Scope,
    operation: AgentDocumentToolOperation,
    slug: AgentDocumentSlug,
    content?: string,
    expression?: string,
  ): Promise<ToolResultPayload> {
    if (operation === "read") {
      const record = await this.store.readAgentDocument(scope.agentKey, slug);
      return recordPayload(scope, "agent", operation, record, {
        slug,
        exists: record !== null,
      });
    }

    if (operation === "set") {
      const record = await this.store.setAgentDocument(scope.agentKey, slug, content ?? "");
      return recordPayload(scope, "agent", operation, record, { slug, exists: true });
    }

    const record = await this.store.transformAgentDocument(scope.agentKey, slug, validateTransformExpression(expression ?? ""));
    return recordPayload(scope, "agent", operation, record, { slug, exists: true });
  }

  private async handleRelationshipDocument(
    scope: Scope,
    operation: AgentDocumentToolOperation,
    slug: RelationshipDocumentSlug,
    content?: string,
    expression?: string,
  ): Promise<ToolResultPayload> {
    if (operation === "read") {
      const record = await this.store.readRelationshipDocument(scope.agentKey, scope.identityId, slug);
      return recordPayload(scope, "relationship", operation, record, {
        slug,
        exists: record !== null,
      });
    }

    if (operation === "set") {
      const record = await this.store.setRelationshipDocument(scope.agentKey, scope.identityId, slug, content ?? "");
      return recordPayload(scope, "relationship", operation, record, { slug, exists: true });
    }

    const record = await this.store.transformRelationshipDocument(
      scope.agentKey,
      scope.identityId,
      slug,
      validateTransformExpression(expression ?? ""),
    );
    return recordPayload(scope, "relationship", operation, record, { slug, exists: true });
  }

  private async handleDiary(
    scope: Scope,
    operation: AgentDocumentToolOperation,
    entryDate: string,
    content?: string,
    expression?: string,
  ): Promise<ToolResultPayload> {
    if (operation === "read") {
      const record = await this.store.readDiaryEntry(scope.agentKey, scope.identityId, entryDate);
      return recordPayload(scope, "diary", operation, record, {
        date: entryDate,
        exists: record !== null,
      });
    }

    if (operation === "set") {
      const record = await this.store.setDiaryEntry(scope.agentKey, scope.identityId, entryDate, content ?? "");
      return recordPayload(scope, "diary", operation, record, { date: entryDate, exists: true });
    }

    const record = await this.store.transformDiaryEntry(
      scope.agentKey,
      scope.identityId,
      entryDate,
      validateTransformExpression(expression ?? ""),
    );
    return recordPayload(scope, "diary", operation, record, { date: entryDate, exists: true });
  }
}
