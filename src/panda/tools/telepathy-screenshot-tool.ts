import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {stripToolArtifactInlineImages, withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import {trimToNull} from "../../lib/strings.js";
import type {TelepathyHub, TelepathyScreenshotCapture} from "../../integrations/telepathy/hub.js";
import {persistTelepathyScreenshotArtifact} from "../../integrations/telepathy/screenshot-artifact.js";
import {resolveToolArtifactMediaRoot, resolveToolArtifactScopeKey} from "./artifact-paths.js";

const DEFAULT_TIMEOUT_MS = 20_000;

function readTelepathyAgentKey(context: unknown, toolName: string): string {
  const agentKey = trimToNull(
    context && typeof context === "object" && !Array.isArray(context)
      ? (context as {agentKey?: unknown}).agentKey
      : null,
  );
  if (!agentKey) {
    throw new ToolError(`${toolName} requires agentKey in the current runtime session context.`);
  }

  return agentKey;
}

function rewriteDetails(
  details: JsonObject,
  persistedPath: string,
  persistedBytes: number,
): JsonObject {
  return withArtifactDetails(details, {
    kind: "image",
    source: "telepathy",
    path: persistedPath,
    mimeType: String(details.mimeType),
    bytes: persistedBytes,
  });
}

export interface TelepathyScreenshotToolOptions {
  service: Pick<TelepathyHub, "requestScreenshot">;
  env?: NodeJS.ProcessEnv;
}

export class TelepathyScreenshotTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof TelepathyScreenshotTool.schema, TContext> {
  static schema = z.object({
    deviceId: z.string().trim().min(1).describe("Connected telepathy device id, for example home-mac."),
    timeoutMs: z.number().int().min(100).max(120_000).optional()
      .describe("Optional request timeout in milliseconds. Use this if the Mac is slow to respond."),
  });

  name = "telepathy_screenshot";
  description =
    "Capture a screenshot from a connected telepathy device by its deviceId. Use this only when the user explicitly wants Panda to inspect their Mac screen.";
  schema = TelepathyScreenshotTool.schema;

  private readonly env: NodeJS.ProcessEnv;
  private readonly service: Pick<TelepathyHub, "requestScreenshot">;

  constructor(options: TelepathyScreenshotToolOptions) {
    super();
    this.env = options.env ?? process.env;
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.deviceId === "string" ? args.deviceId : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (
      !details
      || typeof details !== "object"
      || Array.isArray(details)
      || typeof details.deviceId !== "string"
    ) {
      return super.formatResult(message);
    }

    return `Captured telepathy screenshot from ${details.deviceId}`;
  }

  override redactResultMessage(message: ToolResultMessage<JsonValue>): ToolResultMessage<JsonValue> {
    if (message.toolName !== this.name) {
      return message;
    }

    return stripToolArtifactInlineImages(message);
  }

  async handle(
    args: z.output<typeof TelepathyScreenshotTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const context = (run.context ?? {}) as DefaultAgentSessionContext;
    const agentKey = readTelepathyAgentKey(context, this.name);

    const capture = await this.service.requestScreenshot({
      agentKey,
      deviceId: args.deviceId,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    return this.persistCapture(capture, context);
  }

  private async persistCapture(
    capture: TelepathyScreenshotCapture,
    context: DefaultAgentSessionContext,
  ): Promise<ToolResultPayload> {
    const artifact = await persistTelepathyScreenshotArtifact(capture, {
      rootDir: resolveToolArtifactMediaRoot({
        context,
        env: this.env,
        source: "telepathy",
      }),
      scopeKey: resolveToolArtifactScopeKey(context),
    });

    const details = rewriteDetails({
      action: "screenshot",
      deviceId: capture.deviceId,
      ...(capture.label ? {label: capture.label} : {}),
      path: artifact.path,
      mimeType: capture.mimeType,
      bytes: artifact.byteLength,
    }, artifact.path, artifact.byteLength);

    return {
      content: [
        {
          type: "text",
          text: [
            `Telepathy screenshot saved to ${artifact.path}`,
            `Device: ${capture.deviceId}`,
            ...(capture.label ? [`Label: ${capture.label}`] : []),
          ].join("\n"),
        },
        {
          type: "image",
          data: capture.data,
          mimeType: capture.mimeType,
        },
      ],
      details,
    };
  }
}
