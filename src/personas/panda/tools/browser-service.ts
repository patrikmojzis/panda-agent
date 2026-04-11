import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {type Browser, type BrowserContext, chromium, type Locator, type Page} from "playwright-core";

import {resolvePandaAgentMediaDir, resolvePandaMediaDir} from "../../../app/runtime/data-dir.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {JsonObject, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";
import {
    buildRefSelector,
    getSnapshotScript,
    normalizeSnapshotResult,
    type SnapshotScriptResult
} from "./browser-snapshot.js";
import type {BrowserAction, BrowserProgressStatus, BrowserSessionScope} from "./browser-types.js";
import {
    defaultLookupHostname,
    type LookupHostname,
    resolveSafeHttpTarget,
    trimNonEmptyString
} from "./safe-web-target.js";

const require = createRequire(import.meta.url);
const {version: PLAYWRIGHT_VERSION} = require("playwright-core/package.json") as {version: string};

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_SERVER_PORT = 3000;
const DEFAULT_BROWSER_IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`;
const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
const DEFAULT_BROWSER_SESSION_IDLE_TTL_MS = 10 * 60_000;
const DEFAULT_BROWSER_SESSION_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_BROWSER_MAX_SNAPSHOT_CHARS = 20_000;
const DEFAULT_BROWSER_MAX_EVALUATE_RESULT_CHARS = 20_000;
const DEFAULT_BROWSER_REAPER_INTERVAL_MS = 60_000;
const BROWSER_LABEL = "panda.browser";
const BROWSER_LABEL_VALUE = "1";
const BROWSER_STARTED_AT_LABEL = "panda.startedAtMs";
const BROWSER_THREAD_LABEL = "panda.threadId";

type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options?: {
    encoding?: BufferEncoding;
    signal?: AbortSignal;
  },
) => Promise<{stdout: string; stderr: string}>;

type ConnectBrowserImpl = (
  wsEndpoint: string,
  options?: {timeout?: number},
) => Promise<Browser>;

interface DockerInspectRecord {
  Id?: string;
  Name?: string;
  Config?: {
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
    Status?: string;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{HostIp?: string; HostPort?: string}> | null>;
  };
}

interface BrowserSessionRecord {
  scopeKey: string;
  scope: BrowserSessionScope;
  containerId: string;
  wsEndpoint: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  artifactDir: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  disconnected: boolean;
}

type BrowserElementAction =
  | Extract<BrowserAction, {action: "click"}>
  | Extract<BrowserAction, {action: "type"}>
  | Extract<BrowserAction, {action: "press"}>
  | Extract<BrowserAction, {action: "select"}>
  | Extract<BrowserAction, {action: "screenshot"}>;

type BrowserEvaluateResult = {
  json?: string;
  text?: string;
};

export interface BrowserSessionServiceOptions {
  env?: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileImpl;
  image?: string;
  actionTimeoutMs?: number;
  sessionIdleTtlMs?: number;
  sessionMaxAgeMs?: number;
  maxSnapshotChars?: number;
  maxEvaluateResultChars?: number;
  dataDir?: string;
  lookupHostname?: LookupHostname;
  connectBrowserImpl?: ConnectBrowserImpl;
  now?: () => number;
  reaperIntervalMs?: number;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  return trimNonEmptyString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): {text: string; truncated: boolean} {
  if (value.length <= maxChars) {
    return {text: value, truncated: false};
  }
  return {
    text: value.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ToolError(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatActionTarget(action: BrowserAction): string | undefined {
  if ("ref" in action && trimNonEmpty(action.ref)) {
    return action.ref;
  }
  if ("selector" in action && trimNonEmpty(action.selector)) {
    return action.selector;
  }
  if (action.action === "navigate") {
    return action.url;
  }
  return undefined;
}

function resolveDefaultBrowserImage(): string {
  return DEFAULT_BROWSER_IMAGE;
}

function resolveSeccompProfilePath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../assets/playwright-seccomp-profile.json", import.meta.url)));
}

function normalizeBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function normalizeBrowserLabelValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "unknown";
}

function normalizeScopeKey(context: PandaSessionContext): {scope: BrowserSessionScope; key: string} {
  if (trimNonEmpty(context.threadId)) {
    return {
      scope: "thread",
      key: context.threadId!.trim(),
    };
  }

  return {
    scope: "ephemeral",
    key: `ephemeral-${randomUUID()}`,
  };
}

function resolveSessionContext(context: PandaSessionContext | undefined): PandaSessionContext {
  return context ?? {};
}

function getEvaluateScriptSource(): string {
  return String.raw`
    const runner = new Function("arg", script);
    return Promise.resolve(runner(arg))
      .then((result) => {
        try {
          return {
            json: JSON.stringify(result),
          };
        } catch {
          return {
            text: String(result),
          };
        }
      })
      .catch((error) => ({
        text: String(error instanceof Error ? error.message : error),
      }));
  `;
}

function safeAgentKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new ToolError(`Unsafe agent key for browser artifact path: ${agentKey}`);
  }
  return trimmed;
}

function resolveBrowserMediaRoot(
  context: PandaSessionContext,
  dataDir: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const agentKey = trimNonEmpty(context.agentKey);
  if (dataDir) {
    const root = path.resolve(dataDir);
    if (agentKey) {
      return path.join(root, "agents", safeAgentKey(agentKey), "media");
    }
    return path.join(root, "media");
  }

  if (agentKey) {
    return resolvePandaAgentMediaDir(agentKey, env);
  }
  return resolvePandaMediaDir(env);
}

async function defaultExecFileImpl(
  file: string,
  args: readonly string[],
  options?: {
    encoding?: BufferEncoding;
    signal?: AbortSignal;
  },
): Promise<{stdout: string; stderr: string}> {
  return await execFileAsync(file, [...args], {
    encoding: options?.encoding ?? "utf8",
    signal: options?.signal,
  });
}

async function defaultConnectBrowserImpl(
  wsEndpoint: string,
  options?: {timeout?: number},
): Promise<Browser> {
  return await chromium.connect(wsEndpoint, options);
}

function buildWaitLabel(action: BrowserAction): string {
  if (action.action !== "wait") {
    return action.action;
  }
  if (action.loadState) {
    return `loadState=${action.loadState}`;
  }
  if (action.selector) {
    return `selector=${action.selector}`;
  }
  if (action.text) {
    return `text=${action.text}`;
  }
  if (action.url) {
    return `url=${action.url}`;
  }
  return "wait";
}

export function buildBrowserDockerRunArgs(params: {
  image: string;
  scopeKey: string;
  startedAtMs: number;
}): readonly string[] {
  const threadLabelValue = normalizeBrowserLabelValue(params.scopeKey);
  return [
    "run",
    "-d",
    "--init",
    "--ipc=host",
    "--workdir",
    "/home/pwuser",
    "--user",
    "pwuser",
    "--security-opt",
    `seccomp=${resolveSeccompProfilePath()}`,
    "--label",
    `${BROWSER_LABEL}=${BROWSER_LABEL_VALUE}`,
    "--label",
    `${BROWSER_THREAD_LABEL}=${threadLabelValue}`,
    "--label",
    `${BROWSER_STARTED_AT_LABEL}=${String(params.startedAtMs)}`,
    "-p",
    `127.0.0.1::${PLAYWRIGHT_SERVER_PORT}`,
    params.image,
    "/bin/sh",
    "-lc",
    `npx -y playwright@${PLAYWRIGHT_VERSION} run-server --port ${PLAYWRIGHT_SERVER_PORT} --host 0.0.0.0`,
  ];
}

function buildBrowserImagePayload(params: {
  bytes: Buffer;
  path: string;
  text: string;
  details: JsonObject;
}): ToolResultPayload {
  return {
    content: [
      {
        type: "text",
        text: params.text,
      },
      {
        type: "image",
        data: params.bytes.toString("base64"),
        mimeType: "image/png",
      },
    ],
    details: params.details,
  };
}

export class BrowserSessionService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly execFileImpl: ExecFileImpl;
  private readonly image: string;
  private readonly actionTimeoutMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionMaxAgeMs: number;
  private readonly maxSnapshotChars: number;
  private readonly maxEvaluateResultChars: number;
  private readonly dataDir?: string;
  private readonly lookupHostname: LookupHostname;
  private readonly connectBrowserImpl: ConnectBrowserImpl;
  private readonly now: () => number;
  private readonly reaperIntervalMs: number;
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private reaper: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(options: BrowserSessionServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.execFileImpl = options.execFileImpl ?? defaultExecFileImpl;
    this.image = trimNonEmpty(options.image) ?? resolveDefaultBrowserImage();
    this.actionTimeoutMs = Math.max(1, Math.floor(options.actionTimeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS));
    this.sessionIdleTtlMs = Math.max(1, Math.floor(
      options.sessionIdleTtlMs ?? DEFAULT_BROWSER_SESSION_IDLE_TTL_MS,
    ));
    this.sessionMaxAgeMs = Math.max(1, Math.floor(
      options.sessionMaxAgeMs ?? DEFAULT_BROWSER_SESSION_MAX_AGE_MS,
    ));
    this.maxSnapshotChars = Math.max(1, Math.floor(
      options.maxSnapshotChars ?? DEFAULT_BROWSER_MAX_SNAPSHOT_CHARS,
    ));
    this.maxEvaluateResultChars = Math.max(1, Math.floor(
      options.maxEvaluateResultChars ?? DEFAULT_BROWSER_MAX_EVALUATE_RESULT_CHARS,
    ));
    this.dataDir = trimNonEmpty(options.dataDir);
    this.lookupHostname = options.lookupHostname ?? defaultLookupHostname;
    this.connectBrowserImpl = options.connectBrowserImpl ?? defaultConnectBrowserImpl;
    this.now = options.now ?? Date.now;
    this.reaperIntervalMs = Math.max(1_000, Math.floor(options.reaperIntervalMs ?? DEFAULT_BROWSER_REAPER_INTERVAL_MS));
  }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.cleanupStartupContainers();
        this.reaper = setInterval(() => {
          void this.reapExpiredSessions().catch(() => undefined);
        }, this.reaperIntervalMs);
        this.reaper.unref?.();
        this.started = true;
      })();
    }

    try {
      await this.startPromise;
    } finally {
      if (!this.started) {
        this.startPromise = null;
      }
    }
  }

  private emitProgress<TContext extends PandaSessionContext>(
    run: RunContext<TContext>,
    status: BrowserProgressStatus,
    extra: JsonObject = {},
  ): void {
    run.emitToolProgress({
      status,
      ...extra,
    });
  }

  private resolveActionTimeout(action: BrowserAction): number {
    const actionTimeout = "timeoutMs" in action ? action.timeoutMs : undefined;
    return Math.max(1, Math.floor(actionTimeout ?? this.actionTimeoutMs));
  }

  private async runDocker(args: readonly string[], signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.execFileImpl("docker", args, {
        encoding: "utf8",
        signal,
      });
      return result.stdout.trim();
    } catch (error) {
      const details = isRecord(error)
        ? [trimNonEmpty(String(error.stderr ?? "")), trimNonEmpty(String(error.stdout ?? ""))]
          .filter(Boolean)
          .join("\n")
        : "";
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(details ? `browser docker command failed: ${details}` : `browser docker command failed: ${message}`);
    }
  }

  private async listBrowserContainerIds(): Promise<readonly string[]> {
    const stdout = await this.runDocker([
      "ps",
      "-aq",
      "--filter",
      `label=${BROWSER_LABEL}=${BROWSER_LABEL_VALUE}`,
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async inspectContainers(ids: readonly string[]): Promise<readonly DockerInspectRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const stdout = await this.runDocker(["inspect", ...ids]);
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new ToolError("browser docker inspect returned an invalid payload.");
    }
    return parsed as DockerInspectRecord[];
  }

  private async removeContainers(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.runDocker(["rm", "-f", ...ids]).catch(() => undefined);
  }

  async cleanupStartupContainers(): Promise<void> {
    const ids = await this.listBrowserContainerIds();
    const inspected = await this.inspectContainers(ids);
    const cutoff = this.now() - this.sessionMaxAgeMs;
    const activeSessionIds = new Set(
      [...this.sessions.values()]
        .map((session) => session.containerId),
    );
    const staleIds = inspected
      .filter((record) => {
        const containerId = trimNonEmpty(record.Id);
        if (containerId && !activeSessionIds.has(containerId)) {
          return true;
        }
        const labels = record.Config?.Labels ?? {};
        const startedAtMs = Number.parseInt(labels[BROWSER_STARTED_AT_LABEL] ?? "", 10);
        if ((record.State?.Running ?? false) === false) {
          return true;
        }
        return Number.isFinite(startedAtMs) && startedAtMs < cutoff;
      })
      .map((record) => trimNonEmpty(record.Id))
      .filter((id): id is string => Boolean(id));
    await this.removeContainers(staleIds);
  }

  private async connectToBrowser(wsEndpoint: string, timeoutMs: number): Promise<Browser> {
    const deadline = this.now() + timeoutMs;
    let lastError: unknown = null;
    while (this.now() < deadline) {
      try {
        return await this.connectBrowserImpl(wsEndpoint, {
          timeout: Math.min(1_000, Math.max(100, deadline - this.now())),
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    const message = lastError instanceof Error ? lastError.message : "timed out";
    throw new ToolError(`browser could not connect to Playwright server: ${message}`);
  }

  private async startSession<TContext extends PandaSessionContext>(
    scope: {scope: BrowserSessionScope; key: string},
    run: RunContext<TContext>,
    timeoutMs: number,
  ): Promise<BrowserSessionRecord> {
    const startedAtMs = this.now();
    const artifactRoot = resolveBrowserMediaRoot(resolveSessionContext(run.context), this.dataDir, this.env);
    const artifactDir = path.join(artifactRoot, "browser", normalizeBrowserLabelValue(scope.key));
    await mkdir(artifactDir, {recursive: true});

    const containerId = await this.runDocker(
      buildBrowserDockerRunArgs({
        image: this.image,
        scopeKey: scope.key,
        startedAtMs,
      }),
      run.signal,
    );

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const inspected = await this.inspectContainers([containerId]);
      const container = inspected[0];
      const hostPort = trimNonEmpty(
        container?.NetworkSettings?.Ports?.[`${PLAYWRIGHT_SERVER_PORT}/tcp`]?.[0]?.HostPort,
      );
      if (!hostPort) {
        throw new ToolError("browser could not resolve the Playwright server port mapping.");
      }

      const wsEndpoint = `ws://127.0.0.1:${hostPort}/`;
      browser = await this.connectToBrowser(wsEndpoint, timeoutMs);
      context = await browser.newContext();
      await context.route("**/*", async (route) => {
        const requestUrl = trimNonEmpty(route.request().url());
        if (!requestUrl || !requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
          await route.continue();
          return;
        }
        try {
          await resolveSafeHttpTarget(new URL(requestUrl), this.lookupHostname, "browser");
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      const page = await context.newPage();

      const session: BrowserSessionRecord = {
        scopeKey: scope.key,
        scope: scope.scope,
        containerId,
        wsEndpoint,
        browser,
        context,
        page,
        artifactDir,
        createdAtMs: startedAtMs,
        lastUsedAtMs: startedAtMs,
        disconnected: false,
      };
      context.on?.("page", (nextPage) => {
        void this.switchToPage(session, nextPage).catch(() => undefined);
      });
      browser.on?.("disconnected", () => {
        session.disconnected = true;
      });
      this.sessions.set(scope.key, session);
      return session;
    } catch (error) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await this.removeContainers([containerId]).catch(() => undefined);
      throw error;
    }
  }

  private async closeOtherPages(session: BrowserSessionRecord, keep: Page): Promise<void> {
    for (const page of session.context.pages()) {
      if (page === keep || page.isClosed()) {
        continue;
      }
      await page.close().catch(() => undefined);
    }
  }

  private async switchToPage(session: BrowserSessionRecord, page: Page): Promise<void> {
    session.page = page;
    await this.closeOtherPages(session, page);
  }

  private async ensureActivePage(session: BrowserSessionRecord): Promise<Page> {
    if (!session.page.isClosed()) {
      return session.page;
    }
    const pages = session.context.pages().filter((page) => !page.isClosed());
    const nextPage = pages[pages.length - 1];
    if (nextPage) {
      await this.switchToPage(session, nextPage);
      return nextPage;
    }
    session.page = await session.context.newPage();
    return session.page;
  }

  private async resolveSession<TContext extends PandaSessionContext>(
    scope: {scope: BrowserSessionScope; key: string},
    run: RunContext<TContext>,
    timeoutMs: number,
  ): Promise<BrowserSessionRecord> {
    const existing = this.sessions.get(scope.key);
    if (!existing) {
      return await this.startSession(scope, run, timeoutMs);
    }
    const now = this.now();
    if (
      existing.disconnected ||
      now - existing.lastUsedAtMs >= this.sessionIdleTtlMs ||
      now - existing.createdAtMs >= this.sessionMaxAgeMs
    ) {
      await this.closeSession(scope.key).catch(() => undefined);
      return await this.startSession(scope, run, timeoutMs);
    }
    existing.lastUsedAtMs = now;
    return existing;
  }

  private async settlePage(session: BrowserSessionRecord, timeoutMs: number): Promise<Page> {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const current = await this.ensureActivePage(session);
    await current.waitForLoadState("domcontentloaded", {
      timeout: Math.min(timeoutMs, 5_000),
    }).catch(() => undefined);
    await current.waitForTimeout(150).catch(() => undefined);
    return await this.ensureActivePage(session);
  }

  private async ensureSafeFinalUrl(page: Page): Promise<void> {
    const currentUrl = trimNonEmpty(page.url());
    if (!currentUrl || !/^https?:/i.test(currentUrl)) {
      return;
    }
    await resolveSafeHttpTarget(new URL(currentUrl), this.lookupHostname, "browser");
  }

  private async targetLocator(
    page: Page,
    action: BrowserElementAction,
    timeoutMs: number,
  ): Promise<Locator> {
    const ref = trimNonEmpty(action.ref);
    const target = ref ? buildRefSelector(ref) : trimNonEmpty(action.selector);
    if (!target) {
      throw new ToolError(`browser ${action.action} requires ref or selector.`);
    }
    const locator = page.locator(target).first();
    try {
      await locator.waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      return locator;
    } catch {
      if (ref) {
        throw new ToolError(`browser could not find ref ${ref}. Take a fresh snapshot first.`);
      }
      throw new ToolError(`browser could not find selector ${target}.`);
    }
  }

  private async takeSnapshot(
    session: BrowserSessionRecord,
  ): Promise<{text: string; truncated: boolean; url: string; title: string; elementCount: number}> {
    const page = await this.ensureActivePage(session);
    const raw = await page.evaluate(
      ((input: unknown) => {
        const payload = input as {script?: unknown; maxChars?: unknown};
        const script = typeof payload.script === "string" ? payload.script : "";
        const runner = new Function("maxChars", script);
        return runner(payload.maxChars);
      }) as unknown as string,
      {
        script: getSnapshotScript(),
        maxChars: this.maxSnapshotChars,
      },
    ) as SnapshotScriptResult;
    const normalized = normalizeSnapshotResult(raw, this.maxSnapshotChars);
    return {
      text: normalized.text,
      truncated: normalized.truncated,
      url: normalized.snapshot.url,
      title: normalized.snapshot.title,
      elementCount: normalized.snapshot.elements.length,
    };
  }

  private async buildSnapshotPayload(
    session: BrowserSessionRecord,
    action: BrowserAction["action"],
  ): Promise<ToolResultPayload> {
    const snapshot = await this.takeSnapshot(session);
    return {
      content: [
        {
          type: "text",
          text: snapshot.text,
        },
      ],
      details: {
        action,
        url: snapshot.url,
        title: snapshot.title,
        truncated: snapshot.truncated,
        elementCount: snapshot.elementCount,
        scope: session.scope,
      } satisfies JsonObject,
    };
  }

  private async buildEvaluatePayload(
    session: BrowserSessionRecord,
    action: Extract<BrowserAction, {action: "evaluate"}>,
  ): Promise<ToolResultPayload> {
    const page = await this.ensureActivePage(session);
    const raw = await withTimeout(
      page.evaluate(
        ((input: unknown) => {
          const payload = input as {arg?: unknown; userScript?: unknown; runnerSource?: unknown};
          const arg = payload.arg;
          const script = typeof payload.userScript === "string" ? payload.userScript : "";
          const runnerSource = typeof payload.runnerSource === "string" ? payload.runnerSource : "";
          const run = new Function("arg", "script", runnerSource);
          return run(arg, script);
        }) as unknown as string,
        {
          arg: action.arg,
          userScript: action.script,
          runnerSource: getEvaluateScriptSource(),
        },
      ) as Promise<BrowserEvaluateResult>,
      action.timeoutMs ?? this.actionTimeoutMs,
      "browser evaluate",
    );
    const serialized = trimNonEmpty(raw.json) ?? trimNonEmpty(raw.text) ?? "null";
    const truncated = truncateText(serialized, this.maxEvaluateResultChars);
    return {
      content: [
        {
          type: "text",
          text: truncated.text,
        },
      ],
      details: {
        action: "evaluate",
        scope: session.scope,
        url: page.url(),
        truncated: truncated.truncated,
        result: truncated.text,
      } satisfies JsonObject,
    };
  }

  private async buildScreenshotPayload(
    session: BrowserSessionRecord,
    action: Extract<BrowserAction, {action: "screenshot"}>,
    timeoutMs: number,
  ): Promise<ToolResultPayload> {
    const page = await this.ensureActivePage(session);
    const target = trimNonEmpty(action.ref) || trimNonEmpty(action.selector);
    if (target && action.fullPage) {
      throw new ToolError("browser screenshot does not support fullPage with ref or selector.");
    }
    const bytes = target
      ? await (await this.targetLocator(page, action, timeoutMs)).screenshot({
          timeout: timeoutMs,
        })
      : await page.screenshot({
          fullPage: action.fullPage === true,
          timeout: timeoutMs,
        });
    const buffer = normalizeBuffer(bytes);
    const filePath = path.join(session.artifactDir, `${Date.now()}-${randomUUID()}.png`);
    await writeFile(filePath, buffer);
    const title = await page.title().catch(() => "");
    return buildBrowserImagePayload({
      bytes: buffer,
      path: filePath,
      text: [
        `Browser screenshot saved to ${filePath}`,
        ...(trimNonEmpty(title) ? [`Page title: ${title}`] : []),
        `Page URL: ${page.url()}`,
      ].join("\n"),
      details: {
        action: "screenshot",
        scope: session.scope,
        path: filePath,
        mimeType: "image/png",
        bytes: buffer.length,
        url: page.url(),
        title,
      } satisfies JsonObject,
    });
  }

  private async buildPdfPayload(
    session: BrowserSessionRecord,
    timeoutMs: number,
  ): Promise<ToolResultPayload> {
    const page = await this.ensureActivePage(session);
    const pdf = await withTimeout(page.pdf(), timeoutMs, "browser pdf");
    const buffer = normalizeBuffer(pdf);
    const filePath = path.join(session.artifactDir, `${Date.now()}-${randomUUID()}.pdf`);
    await writeFile(filePath, buffer);
    const title = await page.title().catch(() => "");
    return {
      content: [
        {
          type: "text",
          text: [
            `Browser PDF saved to ${filePath}`,
            ...(trimNonEmpty(title) ? [`Page title: ${title}`] : []),
            `Page URL: ${page.url()}`,
          ].join("\n"),
        },
      ],
      details: {
        action: "pdf",
        scope: session.scope,
        path: filePath,
        mimeType: "application/pdf",
        bytes: buffer.length,
        url: page.url(),
        title,
      } satisfies JsonObject,
    };
  }

  async closeSession(scopeKey: string): Promise<void> {
    const session = this.sessions.get(scopeKey);
    if (!session) {
      return;
    }
    this.sessions.delete(scopeKey);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    await this.removeContainers([session.containerId]).catch(() => undefined);
  }

  async reapExpiredSessions(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()]
      .filter((session) =>
        now - session.lastUsedAtMs >= this.sessionIdleTtlMs
        || now - session.createdAtMs >= this.sessionMaxAgeMs,
      )
      .map((session) => session.scopeKey);
    for (const scopeKey of expired) {
      await this.closeSession(scopeKey);
    }
  }

  async close(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const sessionKeys = [...this.sessions.keys()];
    for (const scopeKey of sessionKeys) {
      await this.closeSession(scopeKey);
    }
  }

  async handle<TContext extends PandaSessionContext>(
    action: BrowserAction,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    await this.ensureStarted();

    const scope = normalizeScopeKey(resolveSessionContext(run.context));
    const timeoutMs = this.resolveActionTimeout(action);
    const persistent = scope.scope === "thread";
    const scopeKey = scope.key;

    if (action.action === "close") {
      this.emitProgress(run, "closing", {scope: scope.scope, scopeKey});
      if (!persistent) {
        return {
          content: [{type: "text", text: "No persistent browser session to close."}],
          details: {action: "close", scope: scope.scope} satisfies JsonObject,
        };
      }
      const hadSession = this.sessions.has(scopeKey);
      await this.closeSession(scopeKey);
      return {
        content: [{
          type: "text",
          text: hadSession ? "Closed the browser session." : "No active browser session to close.",
        }],
        details: {action: "close", scope: scope.scope, closed: hadSession} satisfies JsonObject,
      };
    }

    if (action.action === "navigate") {
      this.emitProgress(run, "navigating", {
        scope: scope.scope,
        url: action.url,
      });
      await resolveSafeHttpTarget(new URL(action.url), this.lookupHostname, "browser");
    }

    let session: BrowserSessionRecord | null = null;
    try {
      if (!this.sessions.has(scopeKey)) {
        this.emitProgress(run, "starting", {scope: scope.scope, scopeKey});
      }
      this.emitProgress(run, "connecting", {scope: scope.scope, scopeKey});
      session = await this.resolveSession(scope, run, timeoutMs);
      const page = await this.ensureActivePage(session);

      switch (action.action) {
        case "navigate": {
          const navigatedPage = page;
          await navigatedPage.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(await this.ensureActivePage(session));
          this.emitProgress(run, "snapshotting", {action: "navigate"});
          return await this.buildSnapshotPayload(session, "navigate");
        }
        case "snapshot":
          this.emitProgress(run, "snapshotting", {action: "snapshot"});
          return await this.buildSnapshotPayload(session, "snapshot");
        case "click": {
          const target = formatActionTarget(action);
          this.emitProgress(run, "acting", {
            action: "click",
            ...(target ? {target} : {}),
          });
          const locator = await this.targetLocator(page, action, timeoutMs);
          await locator.click({
            timeout: timeoutMs,
          });
          await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(await this.ensureActivePage(session));
          this.emitProgress(run, "snapshotting", {action: "click"});
          return await this.buildSnapshotPayload(session, "click");
        }
        case "type": {
          const target = formatActionTarget(action);
          this.emitProgress(run, "acting", {
            action: "type",
            ...(target ? {target} : {}),
          });
          const locator = await this.targetLocator(page, action, timeoutMs);
          try {
            await locator.fill(action.text, {
              timeout: timeoutMs,
            });
          } catch {
            await locator.click({
              timeout: timeoutMs,
            });
            await page.keyboard.insertText(action.text);
          }
          if (action.submit) {
            await locator.press("Enter", {
              timeout: timeoutMs,
            }).catch(async () => {
              await withTimeout(page.keyboard.press("Enter"), timeoutMs, "browser key press");
            });
          }
          await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(await this.ensureActivePage(session));
          this.emitProgress(run, "snapshotting", {action: "type"});
          return await this.buildSnapshotPayload(session, "type");
        }
        case "press": {
          this.emitProgress(run, "acting", {action: "press", key: action.key});
          if (trimNonEmpty(action.ref) || trimNonEmpty(action.selector)) {
            await (await this.targetLocator(page, action, timeoutMs)).press(action.key, {
              timeout: timeoutMs,
            });
          } else {
            await withTimeout(page.keyboard.press(action.key), timeoutMs, "browser key press");
          }
          await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(await this.ensureActivePage(session));
          this.emitProgress(run, "snapshotting", {action: "press"});
          return await this.buildSnapshotPayload(session, "press");
        }
        case "select": {
          const target = formatActionTarget(action);
          this.emitProgress(run, "acting", {
            action: "select",
            ...(target ? {target} : {}),
          });
          const values = Array.isArray(action.values)
            ? action.values
            : typeof action.value === "string"
              ? [action.value]
              : [];
          await (await this.targetLocator(page, action, timeoutMs)).selectOption(
            values.map((value) => ({value})),
            {
              timeout: timeoutMs,
            },
          );
          await this.settlePage(session, timeoutMs);
          this.emitProgress(run, "snapshotting", {action: "select"});
          return await this.buildSnapshotPayload(session, "select");
        }
        case "wait": {
          this.emitProgress(run, "acting", {action: buildWaitLabel(action)});
          if (action.loadState) {
            await page.waitForLoadState(action.loadState, {
              timeout: timeoutMs,
            });
          } else if (action.selector) {
            await page.locator(action.selector).first().waitFor({
              state: "visible",
              timeout: timeoutMs,
            });
          } else if (action.text) {
            await page.waitForFunction((needle) => {
              const root = globalThis as {document?: {body?: {innerText?: string}}};
              return String(root.document?.body?.innerText ?? "").includes(String(needle ?? ""));
            }, action.text, {
              timeout: timeoutMs,
            });
          } else if (action.url) {
            await page.waitForFunction((needle) => {
              const root = globalThis as {location?: {href?: string}};
              return String(root.location?.href ?? "").includes(String(needle ?? ""));
            }, action.url, {
              timeout: timeoutMs,
            });
          }
          await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(await this.ensureActivePage(session));
          this.emitProgress(run, "snapshotting", {action: "wait"});
          return await this.buildSnapshotPayload(session, "wait");
        }
        case "evaluate":
          this.emitProgress(run, "evaluating", {action: "evaluate"});
          return await this.buildEvaluatePayload(session, action);
        case "screenshot":
          this.emitProgress(run, "capturing", {action: "screenshot"});
          return await this.buildScreenshotPayload(session, action, timeoutMs);
        case "pdf":
          this.emitProgress(run, "capturing", {action: "pdf"});
          return await this.buildPdfPayload(session, timeoutMs);
      }
      throw new ToolError("browser reached an invalid action.");
    } finally {
      if (session) {
        session.lastUsedAtMs = this.now();
      }
      if (!persistent) {
        await this.closeSession(scopeKey).catch(() => undefined);
      }
    }
  }
}

let defaultBrowserSessionService: BrowserSessionService | null = null;

export function getDefaultBrowserSessionService(
  options: BrowserSessionServiceOptions = {},
): BrowserSessionService {
  if (!defaultBrowserSessionService) {
    defaultBrowserSessionService = new BrowserSessionService(options);
  }
  return defaultBrowserSessionService;
}
