import {randomUUID} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {resolveAgentMediaDir, resolveMediaDir} from "../../app/runtime/data-dir.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {BrowserToolService} from "../../panda/tools/browser-tool.js";
import type {BrowserAction} from "../../panda/tools/browser-types.js";
import type {
    BrowserPreviewOriginGrant,
    BrowserRunnerActionRequest,
    BrowserRunnerActionResponse,
    BrowserRunnerArtifact,
    BrowserRunnerErrorResponse,
} from "./protocol.js";
import {buildRunnerEndpoint, normalizeBrowserLabelValue, normalizeBrowserScopeKey, safeAgentKey,} from "./shared.js";

const DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS = 5_000;

export interface BrowserRunnerClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  sharedSecret?: string;
  actionTimeoutMs?: number;
  dataDir?: string;
}

function normalizeScopeKey(context: DefaultAgentSessionContext): {scope: "thread" | "ephemeral"; key: string} {
  return normalizeBrowserScopeKey(context);
}

function resolveBrowserMediaRoot(
  context: DefaultAgentSessionContext,
  dataDir: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const agentKey = trimToUndefined(context.agentKey);
  if (dataDir) {
    const root = path.resolve(dataDir);
    if (agentKey) {
      return path.join(root, "agents", safeAgentKey(agentKey), "media");
    }
    return path.join(root, "media");
  }

  if (agentKey) {
    return resolveAgentMediaDir(agentKey, env);
  }
  return resolveMediaDir(env);
}

function makeNetworkTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new Error(`Browser runner did not respond within ${timeoutMs}ms.`));
  }, timeoutMs).unref();
  return controller.signal;
}

function resolveExtension(kind: BrowserRunnerArtifact["kind"], mimeType: string): string {
  if (kind === "pdf" || mimeType === "application/pdf") {
    return ".pdf";
  }
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  return ".png";
}

function readRunnerUrl(env: NodeJS.ProcessEnv): string | undefined {
  return trimToUndefined(env.BROWSER_RUNNER_URL);
}

function readRunnerSharedSecret(env: NodeJS.ProcessEnv): string | undefined {
  return trimToUndefined(env.BROWSER_RUNNER_SHARED_SECRET);
}

function parseBrowserRunnerResponse(payload: unknown): BrowserRunnerActionResponse {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new ToolError("Browser runner returned an invalid response.");
  }

  return payload as unknown as BrowserRunnerActionResponse;
}

async function readBrowserRunnerError(response: Response): Promise<never> {
  let payload: BrowserRunnerErrorResponse | null = null;
  try {
    payload = parseBrowserRunnerResponse(await response.json()) as BrowserRunnerErrorResponse;
  } catch {
    throw new ToolError(`Browser runner request failed with status ${response.status}.`);
  }

  if (payload.ok) {
    throw new ToolError(`Browser runner request failed with status ${response.status}.`);
  }

  throw new ToolError(payload.error, payload.details ? {details: payload.details} : undefined);
}

function rewriteBrowserDetails(
  details: JsonObject | undefined,
  runnerPath: string,
  localPath: string,
  bytes: number,
): JsonObject | undefined {
  if (!details) {
    return undefined;
  }

  const next: JsonObject = {...details};
  if (next.path === runnerPath) {
    next.path = localPath;
  }
  if (typeof next.bytes === "number") {
    next.bytes = bytes;
  }

  if (isRecord(next.artifact)) {
    const artifact = {...next.artifact};
    if (artifact.path === runnerPath) {
      artifact.path = localPath;
    }
    artifact.bytes = bytes;
    next.artifact = artifact;
  }

  return next;
}

function rewriteBrowserText(text: string, runnerPath: string, localPath: string): string {
  return runnerPath ? text.replaceAll(runnerPath, localPath) : text;
}

function normalizeLoopbackHostname(hostname: string): string {
  const normalized = hostname.trim().replace(/\.+$/, "").toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isLoopbackPreviewHost(hostname: string): boolean {
  const normalized = normalizeLoopbackHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value[key] === "string" ? trimToUndefined(value[key]) : undefined;
}

function resolveWorkerPreviewAction(
  action: BrowserAction,
  context: DefaultAgentSessionContext,
): {action: BrowserAction; previewOriginGrant?: BrowserPreviewOriginGrant} {
  if (action.action !== "navigate") {
    return {action};
  }

  const parsedUrl = new URL(action.url);
  if (!["http:", "https:"].includes(parsedUrl.protocol) || !isLoopbackPreviewHost(parsedUrl.hostname)) {
    return {action};
  }

  const executionEnvironment = context.executionEnvironment;
  if (executionEnvironment?.kind !== "disposable_container") {
    return {action};
  }

  const containerName = readStringField(executionEnvironment.metadata, "containerName");
  const network = readStringField(executionEnvironment.metadata, "network");
  if (!containerName || !network) {
    throw new ToolError(
      "Worker browser preview is unavailable because the disposable environment is missing Docker network metadata.",
      {details: {environmentId: executionEnvironment.id}},
    );
  }

  const rewrittenUrl = new URL(parsedUrl);
  rewrittenUrl.hostname = containerName;
  const rewrittenAction: BrowserAction = {
    ...action,
    url: rewrittenUrl.toString(),
  };
  return {
    action: rewrittenAction,
    previewOriginGrant: {
      originalOrigin: parsedUrl.origin,
      resolvedOrigin: rewrittenUrl.origin,
    },
  };
}

export class BrowserRunnerClient<TContext = DefaultAgentSessionContext> implements BrowserToolService<TContext> {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly runnerUrl?: string;
  private readonly sharedSecret?: string;
  private readonly actionTimeoutMs?: number;
  private readonly dataDir?: string;

  constructor(options: BrowserRunnerClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runnerUrl = trimToUndefined(options.runnerUrl);
    this.sharedSecret = trimToUndefined(options.sharedSecret);
    this.actionTimeoutMs = options.actionTimeoutMs;
    this.dataDir = trimToUndefined(options.dataDir);
  }

  private resolveConfig(): {runnerUrl: string; sharedSecret: string} {
    const runnerUrl = this.runnerUrl ?? readRunnerUrl(this.env);
    if (!runnerUrl) {
      throw new ToolError("browser requires BROWSER_RUNNER_URL.");
    }

    const sharedSecret = this.sharedSecret ?? readRunnerSharedSecret(this.env);
    if (!sharedSecret) {
      throw new ToolError("browser requires BROWSER_RUNNER_SHARED_SECRET.");
    }

    return {runnerUrl, sharedSecret};
  }

  private async persistArtifact(
    context: DefaultAgentSessionContext,
    artifact: BrowserRunnerArtifact,
  ): Promise<{path: string; bytes: number}> {
    const scope = normalizeScopeKey(context);
    const root = resolveBrowserMediaRoot(context, this.dataDir, this.env);
    const artifactDir = path.join(root, "browser", normalizeBrowserLabelValue(scope.key));
    await mkdir(artifactDir, {recursive: true});

    const buffer = Buffer.from(artifact.data, "base64");
    const filePath = path.join(
      artifactDir,
      `${Date.now()}-${randomUUID()}${resolveExtension(artifact.kind, artifact.mimeType)}`,
    );
    await writeFile(filePath, buffer);

    return {
      path: filePath,
      bytes: buffer.length,
    };
  }

  async handle(action: BrowserAction, run: RunContext<TContext>): Promise<ToolResultPayload> {
    const {runnerUrl, sharedSecret} = this.resolveConfig();
    const timeoutMs = Math.max(1, Math.floor(("timeoutMs" in action ? action.timeoutMs : undefined) ?? this.actionTimeoutMs ?? 60_000));
    const context = (run.context ?? {}) as DefaultAgentSessionContext;
    const previewRequest = resolveWorkerPreviewAction(action, context);
    const request: BrowserRunnerActionRequest = {
      agentKey: trimToUndefined(context.agentKey) ?? "",
      ...(trimToUndefined(context.sessionId) ? {sessionId: context.sessionId!.trim()} : {}),
      ...(trimToUndefined(context.threadId) ? {threadId: context.threadId!.trim()} : {}),
      action: previewRequest.action,
      ...(previewRequest.previewOriginGrant ? {previewOriginGrant: previewRequest.previewOriginGrant} : {}),
    };

    const response = await this.fetchImpl(buildRunnerEndpoint(runnerUrl, "action"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify(request),
      signal: makeNetworkTimeoutSignal(timeoutMs + DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS),
    });

    if (!response.ok) {
      await readBrowserRunnerError(response);
    }

    const payload = parseBrowserRunnerResponse(await response.json());
    if (!payload.ok) {
      throw new ToolError(payload.error, payload.details ? {details: payload.details} : undefined);
    }

    let text = payload.text;
    let details = payload.details;
    const content: ToolResultPayload["content"] = [
      {
        type: "text",
        text,
      },
    ];

    if (payload.artifact) {
      const persisted = await this.persistArtifact(context, payload.artifact);
      text = rewriteBrowserText(text, payload.artifact.path, persisted.path);
      details = rewriteBrowserDetails(details, payload.artifact.path, persisted.path, persisted.bytes);
      content[0] = {
        type: "text",
        text,
      };

      if (payload.artifact.kind === "image") {
        content.push({
          type: "image",
          data: payload.artifact.data,
          mimeType: payload.artifact.mimeType,
        });
      }
    }

    return {
      content,
      ...(details ? {details} : {}),
    };
  }

  async close(): Promise<void> {}
}

let defaultBrowserRunnerClient: BrowserRunnerClient | null = null;

export function getDefaultBrowserRunnerClient(
  options: BrowserRunnerClientOptions = {},
): BrowserRunnerClient {
  if (!defaultBrowserRunnerClient) {
    defaultBrowserRunnerClient = new BrowserRunnerClient(options);
  }

  return defaultBrowserRunnerClient;
}
