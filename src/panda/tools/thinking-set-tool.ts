import {z} from "zod";
import type {ThinkingLevel, ToolResultMessage} from "@mariozechner/pi-ai";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {stringifyUnknown} from "../../kernel/agent/helpers/stringify.js";
import type {JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {isRecord} from "../../lib/records.js";
import {buildJsonToolPayload} from "./shared.js";

const thinkingSetToolSchema = z.object({
  level: z.enum(["off", "low", "medium", "high", "xhigh"]),
  persist: z.boolean().optional().default(false),
  reason: z.string().trim().min(1).optional(),
});

function readThreadId(context: unknown): string | null {
  if (!isRecord(context) || typeof context.threadId !== "string") {
    return null;
  }

  const trimmed = context.threadId.trim();
  return trimmed || null;
}

function normalizeThinkingLevel(
  level: z.output<typeof thinkingSetToolSchema>["level"],
): ThinkingLevel | undefined {
  return level === "off" ? undefined : level;
}

function assertThinkingControlAvailable<TContext>(run: RunContext<TContext>): void {
  try {
    const currentThinking = run.getThinking();
    run.setThinking(currentThinking);
  } catch (error) {
    throw new ToolError(`Live thinking control is unavailable in this runtime: ${stringifyUnknown(error, {preferErrorMessage: true})}`);
  }
}

function applyLiveThinking<TContext>(
  run: RunContext<TContext>,
  nextThinking: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  try {
    run.setThinking(nextThinking);
    const liveThinking = run.getThinking();
    if (liveThinking !== nextThinking) {
      throw new Error(
        `Thinking update did not stick. Expected ${nextThinking ?? "off"} but runtime reported ${liveThinking ?? "off"}.`,
      );
    }

    return liveThinking;
  } catch (error) {
    throw new ToolError(`Failed to update live thinking: ${stringifyUnknown(error, {preferErrorMessage: true})}`);
  }
}

export interface ThinkingSetPersistence {
  updateThreadThinking(
    threadId: string,
    thinking: ThinkingLevel | null,
  ): Promise<{thinking?: ThinkingLevel}>;
}

export interface ThinkingSetToolOptions {
  persistence?: ThinkingSetPersistence;
}

export class ThinkingSetTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof thinkingSetToolSchema, TContext> {
  static schema = thinkingSetToolSchema;

  name = "thinking_set";
  description = [
    "Adjust the current run's thinking effort for the next model turn.",
    "Use persist=true to also update the current thread's stored default.",
  ].join("\n");
  schema = thinkingSetToolSchema;

  private readonly persistence?: ThinkingSetPersistence;

  constructor(options: ThinkingSetToolOptions = {}) {
    super();
    this.persistence = options.persistence;
  }

  override formatCall(args: Record<string, unknown>): string {
    const level = typeof args.level === "string" ? args.level : "unknown";
    const persist = args.persist === true ? " persisted" : "";
    return `${level}${persist}`;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!isRecord(details) || typeof details.liveThinking !== "string" && details.liveThinking !== null) {
      return super.formatResult(message);
    }

    const liveThinking = details.liveThinking ?? "off";
    const persisted = details.persisted === true ? " and persisted" : "";
    return `Thinking set to ${liveThinking}${persisted}.`;
  }

  async handle(
    args: z.output<typeof thinkingSetToolSchema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const nextThinking = normalizeThinkingLevel(args.level);

    if (!args.persist) {
      const liveThinking = applyLiveThinking(run, nextThinking);
      return buildJsonToolPayload({
        requestedLevel: args.level,
        liveThinking: liveThinking ?? null,
        persistRequested: false,
        persisted: false,
        ...(args.reason ? {reason: args.reason} : {}),
      });
    }

    const threadId = readThreadId(run.context);
    if (!threadId) {
      throw new ToolError("Persisting thinking requires threadId in the runtime session context.");
    }

    if (!this.persistence) {
      throw new ToolError("Thinking persistence is unavailable in this runtime.");
    }

    assertThinkingControlAvailable(run);

    let storedThinking: ThinkingLevel | undefined;
    try {
      const persisted = await this.persistence.updateThreadThinking(threadId, nextThinking ?? null);
      storedThinking = persisted.thinking;
    } catch (error) {
      throw new ToolError(`Failed to persist thinking: ${stringifyUnknown(error, {preferErrorMessage: true})}`);
    }

    const liveThinking = applyLiveThinking(run, nextThinking);
    return buildJsonToolPayload({
      requestedLevel: args.level,
      liveThinking: liveThinking ?? null,
      persistRequested: true,
      persisted: true,
      storedThinking: storedThinking ?? null,
      ...(args.reason ? {reason: args.reason} : {}),
    });
  }
}
