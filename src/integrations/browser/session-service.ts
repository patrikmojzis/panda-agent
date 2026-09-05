import {randomUUID} from "node:crypto";
import {mkdir, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";

import {
    type Browser,
    type BrowserContext,
    chromium,
    type LaunchOptions,
    type Locator,
    type Page
} from "playwright-core";

import {resolveDataDir} from "../../lib/data-dir.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import {sleepWithSignal} from "../../lib/async.js";
import {pathExists} from "../../lib/fs.js";
import {normalizePathLabel} from "../../lib/path-segments.js";
import type {JsonObject} from "../../lib/json.js";
import {trimToUndefined, truncateTextWithStatus} from "../../lib/strings.js";
import {
    buildBrowserPdfArtifactPayload,
    buildBrowserScreenshotArtifactPayload,
    type BrowserArtifactSnapshot,
} from "./artifacts.js";
import {
    buildRefSelector,
    getSnapshotScript,
    normalizeSnapshotResult,
    renderBrowserSnapshot,
    SNAPSHOT_REF_ATTRIBUTE,
    type SnapshotScriptResult,
} from "./snapshot.js";
import {buildBrowserExternalContentDetails, wrapBrowserExternalContent,} from "./output.js";
import {
    buildBrowserContextOptions,
    buildBrowserDeviceDetailsForProfile,
    buildBrowserRuntimeDeviceExpectationForProfile,
} from "./device-profiles.js";
import {
    browserNavigationProtocols,
    browserNetworkProtocols,
    buildPreviewPrivateOrigins,
    isBrowserNetworkProtocol,
    isMainFrameNavigationRequest,
    isWebSocketProtocol,
    readAllowedPrivateHostnames,
} from "./navigation-policy.js";
import type {
    BrowserAction,
    BrowserDeviceProfile,
    BrowserProgressStatus,
    BrowserSessionScope,
    BrowserSnapshot,
    BrowserSnapshotChanges,
    BrowserSnapshotMode,
} from "./action-types.js";
import {buildSnapshotChanges, toJsonSnapshotChanges} from "./snapshot-changes.js";
import {defaultLookupHostname, type LookupHostname, resolveSafeHttpTarget,} from "../web/safe-web-target.js";
import type {BrowserPreviewOriginGrant} from "./protocol.js";
import {
    normalizeBrowserSessionScopeKey,
    type BrowserRuntimeContext,
    safeAgentKey,
} from "./shared.js";

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
const DEFAULT_BROWSER_SESSION_IDLE_TTL_MS = 10 * 60_000;
const DEFAULT_BROWSER_SESSION_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_BROWSER_MAX_SNAPSHOT_CHARS = 20_000;
const DEFAULT_BROWSER_MAX_EVALUATE_RESULT_CHARS = 20_000;
const DEFAULT_BROWSER_REAPER_INTERVAL_MS = 60_000;
const DEFAULT_BROWSER_RUNNER_SUBDIR = "browser-runner";

type LaunchBrowserImpl = (options?: LaunchOptions) => Promise<Browser>;

interface BrowserSessionRecord {
  scopeKey: string;
  scope: BrowserSessionScope;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  deviceProfile: BrowserDeviceProfile;
  device: JsonObject;
  runtimeDevice?: JsonObject;
  artifactDir: string;
  storageStatePath?: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  disconnected: boolean;
  previewOriginGrant?: BrowserPreviewOriginGrant;
  operation: BrowserOperation;
}

interface BrowserOperation {
  signal: AbortSignal;
  error?: ToolError;
  browser?: Browser;
  context?: BrowserContext;
  session?: BrowserSessionRecord;
  publication: Promise<void>;
  artifacts: Set<string>;
  check(): void;
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

type BrowserSnapshotCapture = BrowserArtifactSnapshot;

type BrowserActionBaseline = {
  page: Page;
  snapshot: BrowserSnapshot;
};

type BrowserResolvedSessionScope = {
  scope: BrowserSessionScope;
  key: string;
  deviceProfile: BrowserDeviceProfile;
};

const RUNTIME_DEVICE_PROBE_HTML = `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Panda browser device profile probe</title>
</head>
<body>probe</body>
</html>`;

function shouldAssertRuntimeDeviceProfile(deviceProfile: BrowserDeviceProfile): boolean {
  return deviceProfile !== "desktop";
}

function cloneRuntimeViewport(value: unknown): {width: number; height: number} | undefined {
  if (
    typeof value === "object"
    && value !== null
    && "width" in value
    && "height" in value
    && typeof (value as {width?: unknown}).width === "number"
    && typeof (value as {height?: unknown}).height === "number"
  ) {
    return {
      width: (value as {width: number}).width,
      height: (value as {height: number}).height,
    };
  }
  return undefined;
}

function readRuntimeDeviceProbeInPage(): JsonObject {
  const root = globalThis as {
    innerWidth?: unknown;
    innerHeight?: unknown;
    devicePixelRatio?: unknown;
    navigator?: {
      userAgent?: unknown;
      maxTouchPoints?: unknown;
    };
  };
  const maxTouchPoints = typeof root.navigator?.maxTouchPoints === "number"
    ? root.navigator.maxTouchPoints
    : 0;

  return {
    viewport: {
      width: typeof root.innerWidth === "number" ? root.innerWidth : 0,
      height: typeof root.innerHeight === "number" ? root.innerHeight : 0,
    },
    deviceScaleFactor: typeof root.devicePixelRatio === "number" ? root.devicePixelRatio : 0,
    userAgent: typeof root.navigator?.userAgent === "string" ? root.navigator.userAgent : "",
    maxTouchPoints,
    hasTouch: maxTouchPoints > 0,
  };
}

function normalizeRuntimeDeviceProbe(
  deviceProfile: BrowserDeviceProfile,
  value: unknown,
): JsonObject {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const viewport = cloneRuntimeViewport(raw.viewport) ?? {width: 0, height: 0};
  const maxTouchPoints = typeof raw.maxTouchPoints === "number" && Number.isFinite(raw.maxTouchPoints)
    ? raw.maxTouchPoints
    : 0;

  return {
    profile: deviceProfile,
    viewport,
    deviceScaleFactor: typeof raw.deviceScaleFactor === "number" && Number.isFinite(raw.deviceScaleFactor)
      ? raw.deviceScaleFactor
      : 0,
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : "",
    maxTouchPoints,
    hasTouch: raw.hasTouch === true || maxTouchPoints > 0,
  };
}

function buildRuntimeDeviceMismatches(expected: JsonObject, actual: JsonObject): JsonObject[] {
  const mismatches: JsonObject[] = [];
  const expectedViewport = cloneRuntimeViewport(expected.viewport);
  if (expectedViewport) {
    const actualViewport = cloneRuntimeViewport(actual.viewport);
    if (
      !actualViewport
      || actualViewport.width !== expectedViewport.width
      || actualViewport.height !== expectedViewport.height
    ) {
      mismatches.push({
        field: "viewport",
        expected: expectedViewport,
        actual: actualViewport ?? null,
      });
    }
  }

  if (typeof expected.deviceScaleFactor === "number") {
    const actualDeviceScaleFactor = typeof actual.deviceScaleFactor === "number"
      ? actual.deviceScaleFactor
      : null;
    if (actualDeviceScaleFactor === null || Math.abs(actualDeviceScaleFactor - expected.deviceScaleFactor) > 0.001) {
      mismatches.push({
        field: "deviceScaleFactor",
        expected: expected.deviceScaleFactor,
        actual: actualDeviceScaleFactor,
      });
    }
  }

  if (typeof expected.userAgent === "string" && actual.userAgent !== expected.userAgent) {
    mismatches.push({
      field: "userAgent",
      expected: expected.userAgent,
      actual: typeof actual.userAgent === "string" ? actual.userAgent : null,
    });
  }

  const actualHasTouch = actual.hasTouch === true;
  if (expected.hasTouch === true && !actualHasTouch) {
    mismatches.push({
      field: "hasTouch",
      expected: true,
      actual: actualHasTouch,
      maxTouchPoints: typeof actual.maxTouchPoints === "number" ? actual.maxTouchPoints : 0,
    });
  }

  return mismatches;
}

function buildSessionDeviceResultDetails(session: BrowserSessionRecord): JsonObject {
  return {
    deviceProfile: session.deviceProfile,
    device: session.device,
    ...(session.runtimeDevice ? {runtimeDevice: session.runtimeDevice} : {}),
  };
}

function runSnapshotScriptInPage(input: {
  script?: unknown;
  maxChars?: unknown;
}): SnapshotScriptResult {
  const script = typeof input.script === "string" ? input.script : "";
  const runner = new Function("maxChars", script) as (maxChars: unknown) => SnapshotScriptResult;
  return runner(input.maxChars);
}

function runEvaluateScriptInPage(input: {
  arg?: unknown;
  userScript?: unknown;
  runnerSource?: unknown;
}): BrowserEvaluateResult {
  const script = typeof input.userScript === "string" ? input.userScript : "";
  const runnerSource = typeof input.runnerSource === "string" ? input.runnerSource : "";
  const run = new Function("arg", "script", runnerSource) as (
    arg: unknown,
    script: string,
  ) => BrowserEvaluateResult;
  return run(input.arg, script);
}

export interface BrowserSessionServiceOptions {
  env?: NodeJS.ProcessEnv;
  actionTimeoutMs?: number;
  sessionIdleTtlMs?: number;
  sessionMaxAgeMs?: number;
  maxSnapshotChars?: number;
  maxEvaluateResultChars?: number;
  dataDir?: string;
  lookupHostname?: LookupHostname;
  launchBrowserImpl?: LaunchBrowserImpl;
  launchOptions?: LaunchOptions;
  now?: () => number;
  reaperIntervalMs?: number;
  allowPrivateHostnames?: readonly string[];
}

function buildTimeoutError(label: string, timeoutMs: number, details: JsonObject = {}): ToolError {
  return new ToolError(`${label} timed out after ${timeoutMs}ms.`, {
    details: {
      ...details,
      timedOut: true,
      timeoutMs,
    },
  });
}

function isTimeoutToolError(error: unknown): boolean {
  if (!(error instanceof ToolError)) {
    return false;
  }
  return typeof error.details === "object"
    && error.details !== null
    && !Array.isArray(error.details)
    && (error.details as {timedOut?: unknown}).timedOut === true;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  details: JsonObject = {},
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(buildTimeoutError(label, timeoutMs, details));
    }, timeoutMs);
    timer.unref?.();

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
  if ("ref" in action && trimToUndefined(action.ref)) {
    return action.ref;
  }
  if ("selector" in action && trimToUndefined(action.selector)) {
    return action.selector;
  }
  if (action.action === "navigate") {
    return action.url;
  }
  return undefined;
}

function resolveBrowserRunnerRoot(dataDir: string | undefined, env: NodeJS.ProcessEnv): string {
  const configured = trimToUndefined(dataDir);
  if (configured) {
    return path.resolve(configured);
  }

  return path.join(resolveDataDir(env), DEFAULT_BROWSER_RUNNER_SUBDIR);
}

function resolveSessionContext(context: BrowserRuntimeContext | undefined): BrowserRuntimeContext {
  return context ?? {
    agentKey: "",
    sessionId: "",
    threadId: "",
  };
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

function resolveBrowserSessionRoot(
  context: BrowserRuntimeContext,
  dataDir: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const root = resolveBrowserRunnerRoot(dataDir, env);
  const agentKey = trimToUndefined(context.agentKey);
  if (agentKey) {
    return path.join(root, "agents", safeAgentKey(agentKey));
  }
  return path.join(root, "anonymous");
}

async function defaultLaunchBrowserImpl(options?: LaunchOptions): Promise<Browser> {
  return await chromium.launch({
    headless: true,
    ...options,
  });
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

export class BrowserSessionService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly actionTimeoutMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionMaxAgeMs: number;
  private readonly maxSnapshotChars: number;
  private readonly maxEvaluateResultChars: number;
  private readonly dataDir?: string;
  private readonly lookupHostname: LookupHostname;
  private readonly launchBrowserImpl: LaunchBrowserImpl;
  private readonly launchOptions?: LaunchOptions;
  private readonly now: () => number;
  private readonly reaperIntervalMs: number;
  private readonly allowPrivateHostnames: readonly string[];
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly admission = new Map<string, Promise<void>>();
  private readonly closingBrowsers = new WeakSet<Browser>();
  private readonly closingContexts = new WeakSet<BrowserContext>();
  private reaper: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(options: BrowserSessionServiceOptions = {}) {
    this.env = options.env ?? process.env;
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
    this.dataDir = trimToUndefined(options.dataDir);
    this.lookupHostname = options.lookupHostname ?? defaultLookupHostname;
    this.launchBrowserImpl = options.launchBrowserImpl ?? defaultLaunchBrowserImpl;
    this.launchOptions = options.launchOptions;
    this.now = options.now ?? Date.now;
    this.reaperIntervalMs = Math.max(1_000, Math.floor(options.reaperIntervalMs ?? DEFAULT_BROWSER_REAPER_INTERVAL_MS));
    this.allowPrivateHostnames = readAllowedPrivateHostnames(this.env, options.allowPrivateHostnames);
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

  private emitProgress<TContext extends BrowserRuntimeContext>(
    run: RunContext<TContext>,
    operation: BrowserOperation,
    status: BrowserProgressStatus,
    extra: JsonObject = {},
  ): void {
    if (operation.error) {
      return;
    }
    run.emitToolProgress({
      status,
      ...extra,
    });
    operation.check();
  }

  private async ensureSafeBrowserTarget(
    url: URL,
    previewOriginGrant: BrowserPreviewOriginGrant | undefined,
    allowedProtocols: readonly string[] = browserNavigationProtocols(),
  ): Promise<void> {
    await resolveSafeHttpTarget(url, this.lookupHostname, "browser", {
      allowPrivateHostnames: this.allowPrivateHostnames,
      allowPrivateOrigins: buildPreviewPrivateOrigins(previewOriginGrant),
      allowedProtocols,
    });
  }

  private clearPreviewGrantIfLeavingOrigin(
    session: BrowserSessionRecord,
    url: URL,
  ): void {
    const grant = session.previewOriginGrant;
    if (!grant) {
      return;
    }
    if (url.origin !== grant.resolvedOrigin) {
      session.previewOriginGrant = undefined;
    }
  }

  private resolveActionTimeout(action: BrowserAction): number {
    const actionTimeout = "timeoutMs" in action ? action.timeoutMs : undefined;
    return Math.max(1, Math.floor(actionTimeout ?? this.actionTimeoutMs));
  }

  private reserveScope(scopeKey: string): {ready: Promise<void>; release(): void} {
    const ready = this.admission.get(scopeKey) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const tail = ready.then(() => released);
    this.admission.set(scopeKey, tail);
    void tail.then(() => {
      if (this.admission.get(scopeKey) === tail) {
        this.admission.delete(scopeKey);
      }
    });
    return {ready, release};
  }

  private discardResources(operation: BrowserOperation): void {
    const {session, context, browser} = operation;
    if (session && this.sessions.get(session.scopeKey) === session) {
      this.sessions.delete(session.scopeKey);
    }
    // Browser closure must not wait for storageState or graceful context closure.
    if (browser && !this.closingBrowsers.has(browser)) {
      this.closingBrowsers.add(browser);
      void browser.close().catch(() => undefined);
    }
    if (context && !this.closingContexts.has(context)) {
      this.closingContexts.add(context);
      void context.close().catch(() => undefined);
    }
  }

  private async runWithActionTimeout<T>(
    action: BrowserAction,
    scopeKey: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    execute: (operation: BrowserOperation) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const operation: BrowserOperation = {
      signal: controller.signal,
      publication: Promise.resolve(),
      artifacts: new Set(),
      check: () => {
        if (operation.error) {
          this.discardResources(operation);
          throw operation.error;
        }
      },
    };
    let rejectCancelled!: (error: ToolError) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const stop = (error: ToolError) => {
      if (operation.error) return;
      operation.error = error;
      this.discardResources(operation);
      controller.abort(error);
      rejectCancelled(error);
    };
    const onAbort = () => stop(new ToolError("Browser action was cancelled.", {details: {cancelled: true}}));
    signal?.addEventListener("abort", onAbort, {once: true});
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => stop(buildTimeoutError(`browser action ${action.action}`, timeoutMs, {
      action: action.action,
    })), timeoutMs);
    timer.unref?.();
    const admission = this.reserveScope(scopeKey);
    try {
      await Promise.race([admission.ready, cancelled]);
      operation.check();
      const result = await Promise.race([execute(operation), cancelled]);
      operation.check();
      return result;
    } catch (error) {
      if (isTimeoutToolError(error)) {
        stop(error as ToolError);
      }
      throw operation.error ?? error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // An issued rename commits before the next owner enters. Cancellation
      // returns promptly; only admission waits for that publication to settle.
      void operation.publication.catch(() => undefined).then(async () => {
        if (operation.error) {
          await Promise.all([...operation.artifacts].map((file) => rm(file, {force: true}).catch(() => undefined)));
        }
      }).finally(admission.release);
    }
  }

  private async createBrowserContext(
    browser: Browser,
    deviceProfile: BrowserDeviceProfile,
    operation: BrowserOperation,
    storageStatePath?: string,
  ): Promise<BrowserContext> {
    const hasStorageState = storageStatePath && await pathExists(storageStatePath);
    operation.check();
    if (!hasStorageState) {
      return await browser.newContext(buildBrowserContextOptions(deviceProfile));
    }

    try {
      return await browser.newContext(buildBrowserContextOptions(deviceProfile, storageStatePath));
    } catch {
      operation.check();
      await this.publish(operation, () => rm(storageStatePath, {force: true})).catch(() => undefined);
      operation.check();
      return await browser.newContext(buildBrowserContextOptions(deviceProfile));
    }
  }

  private async probeRuntimeDeviceProfile(
    context: BrowserContext,
    deviceProfile: BrowserDeviceProfile,
    timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<JsonObject> {
    return await withTimeout((async () => {
      const page = await context.newPage();
      try {
        operation.check();
        await page.setContent(RUNTIME_DEVICE_PROBE_HTML, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(timeoutMs, 10_000),
        });
        operation.check();
        const raw = await page.evaluate(readRuntimeDeviceProbeInPage);
        operation.check();
        return normalizeRuntimeDeviceProbe(deviceProfile, raw);
      } finally {
        await page.close().catch(() => undefined);
      }
    })(), Math.min(timeoutMs, 10_000), "browser deviceProfile probe", {
      deviceProfile,
    });
  }

  private async assertRuntimeDeviceProfile(
    context: BrowserContext,
    deviceProfile: BrowserDeviceProfile,
    timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<JsonObject | undefined> {
    if (!shouldAssertRuntimeDeviceProfile(deviceProfile)) {
      return undefined;
    }

    const expected = buildBrowserRuntimeDeviceExpectationForProfile(deviceProfile);
    const actual = await this.probeRuntimeDeviceProfile(context, deviceProfile, timeoutMs, operation);
    const mismatches = buildRuntimeDeviceMismatches(expected, actual);
    if (mismatches.length > 0) {
      throw new ToolError(`browser deviceProfile=${deviceProfile} did not apply expected runtime metrics.`, {
        details: {
          deviceProfile,
          expected,
          actual,
          mismatches,
        },
      });
    }

    return actual;
  }

  private publish(operation: BrowserOperation, write: () => Promise<void>): Promise<void> {
    operation.check();
    const publication = write();
    operation.publication = publication;
    return publication;
  }

  private async writeArtifact(session: BrowserSessionRecord, filePath: string, bytes: Buffer): Promise<void> {
    const operation = session.operation;
    operation.check();
    const stagedPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(stagedPath, bytes);
      operation.check();
      operation.artifacts.add(filePath);
      await this.publish(operation, () => rename(stagedPath, filePath));
      operation.check();
    } finally {
      await rm(stagedPath, {force: true}).catch(() => undefined);
    }
  }

  private async persistStorageState(session: BrowserSessionRecord | null | undefined): Promise<void> {
    if (!session?.storageStatePath || session.scope === "ephemeral") {
      return;
    }
    const operation = session.operation;
    operation.check();
    await mkdir(path.dirname(session.storageStatePath), {recursive: true});
    operation.check();
    const stagedPath = `${session.storageStatePath}.${randomUUID()}.tmp`;
    try {
      await session.context.storageState({path: stagedPath});
      operation.check();
      await this.publish(operation, () => rename(stagedPath, session.storageStatePath!));
      operation.check();
    } finally {
      await rm(stagedPath, {force: true}).catch(() => undefined);
    }
  }

  private async startSession<TContext extends BrowserRuntimeContext>(
    scope: BrowserResolvedSessionScope,
    run: RunContext<TContext>,
    _timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<BrowserSessionRecord> {
    const startedAtMs = this.now();
    const sessionRoot = path.join(
      resolveBrowserSessionRoot(resolveSessionContext(run.context), this.dataDir, this.env),
      "sessions",
      normalizePathLabel(scope.key),
    );
    const artifactDir = path.join(sessionRoot, "artifacts");
    const storageStatePath = scope.scope !== "ephemeral"
      ? path.join(sessionRoot, "storage-state.json")
      : undefined;
    await mkdir(artifactDir, {recursive: true});
    operation.check();

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let session: BrowserSessionRecord | null = null;
    try {
      browser = await this.launchBrowserImpl(this.launchOptions);
      operation.browser = browser;
      operation.check();
      context = await this.createBrowserContext(browser, scope.deviceProfile, operation, storageStatePath);
      operation.context = context;
      operation.check();
      const runtimeDevice = await this.assertRuntimeDeviceProfile(context, scope.deviceProfile, _timeoutMs, operation);
      operation.check();
      const checkRoute = () => {
        (session?.operation ?? operation).check();
        if (session && (session.disconnected || this.sessions.get(scope.key) !== session)) {
          throw new ToolError("Browser session is closed.");
        }
      };
      await context.route("**/*", async (route) => {
        const request = route.request();
        const requestUrl = trimToUndefined(request.url());
        try {
          checkRoute();
          if (!requestUrl) {
            await route.continue();
            return;
          }
          const url = new URL(requestUrl);
          if (!isBrowserNetworkProtocol(url.protocol)) {
            await route.continue();
            return;
          }
          if (session && isMainFrameNavigationRequest(request)) {
            this.clearPreviewGrantIfLeavingOrigin(session, url);
          }
          await this.ensureSafeBrowserTarget(url, session?.previewOriginGrant, browserNetworkProtocols());
          checkRoute();
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      operation.check();
      await context.routeWebSocket?.("**/*", async (ws) => {
        const requestUrl = trimToUndefined(ws.url());
        if (!requestUrl) {
          await ws.close({code: 1008, reason: "Blocked by browser policy"}).catch(() => undefined);
          return;
        }
        try {
          checkRoute();
          const url = new URL(requestUrl);
          if (!isWebSocketProtocol(url.protocol)) {
            await ws.close({code: 1008, reason: "Blocked by browser policy"}).catch(() => undefined);
            return;
          }
          await this.ensureSafeBrowserTarget(url, session?.previewOriginGrant, ["ws:", "wss:"]);
          checkRoute();
          ws.connectToServer();
        } catch {
          await ws.close({code: 1008, reason: "Blocked by browser policy"}).catch(() => undefined);
        }
      });
      operation.check();
      const page = await context.newPage();
      if (operation.error) await page.close().catch(() => undefined);
      operation.check();

      session = {
        scopeKey: scope.key,
        scope: scope.scope,
        browser,
        context,
        page,
        deviceProfile: scope.deviceProfile,
        device: buildBrowserDeviceDetailsForProfile(scope.deviceProfile),
        runtimeDevice,
        artifactDir,
        storageStatePath,
        createdAtMs: startedAtMs,
        lastUsedAtMs: startedAtMs,
        disconnected: false,
        operation,
      };
      operation.session = session;
      const createdSession = session;
      context.on?.("page", (nextPage) => {
        void this.switchToPage(createdSession, nextPage).catch(() => undefined);
      });
      browser.on?.("disconnected", () => {
        createdSession.disconnected = true;
      });
      operation.check();
      this.sessions.set(scope.key, session);
      return session;
    } catch (error) {
      this.discardResources(operation);
      throw error;
    }
  }

  private async closeOtherPages(session: BrowserSessionRecord, keep: Page): Promise<void> {
    for (const page of session.context.pages()) {
      session.operation.check();
      if (page === keep || page.isClosed()) {
        continue;
      }
      await page.close().catch(() => undefined);
    }
  }

  private async switchToPage(session: BrowserSessionRecord, page: Page): Promise<void> {
    if (session.operation.error || session.disconnected || this.sessions.get(session.scopeKey) !== session) {
      await page.close().catch(() => undefined);
      return;
    }
    session.page = page;
    await this.closeOtherPages(session, page);
  }

  private async ensureActivePage(session: BrowserSessionRecord): Promise<Page> {
    session.operation.check();
    if (!session.page.isClosed()) {
      return session.page;
    }
    const pages = session.context.pages().filter((page) => !page.isClosed());
    const nextPage = pages[pages.length - 1];
    if (nextPage) {
      await this.switchToPage(session, nextPage);
      session.operation.check();
      return nextPage;
    }
    const page = await session.context.newPage();
    if (session.operation.error) {
      await page.close().catch(() => undefined);
      session.operation.check();
    }
    session.page = page;
    return session.page;
  }

  private async resolveSession<TContext extends BrowserRuntimeContext>(
    scope: BrowserResolvedSessionScope,
    run: RunContext<TContext>,
    timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<BrowserSessionRecord> {
    operation.check();
    const existing = this.sessions.get(scope.key);
    if (!existing) {
      return await this.startSession(scope, run, timeoutMs, operation);
    }
    const now = this.now();
    if (
      existing.disconnected ||
      now - existing.lastUsedAtMs >= this.sessionIdleTtlMs ||
      now - existing.createdAtMs >= this.sessionMaxAgeMs
    ) {
      this.ownSession(operation, existing);
      await this.closeRecord(existing).catch(() => undefined);
      operation.check();
      return await this.startSession(scope, run, timeoutMs, operation);
    }
    existing.lastUsedAtMs = now;
    this.ownSession(operation, existing);
    return existing;
  }

  private async settlePage(session: BrowserSessionRecord, timeoutMs: number): Promise<Page> {
    await sleepWithSignal(250, session.operation.signal);
    const current = await this.ensureActivePage(session);
    await current.waitForLoadState("domcontentloaded", {
      timeout: Math.min(timeoutMs, 5_000),
    }).catch(() => undefined);
    session.operation.check();
    await current.waitForTimeout(150).catch(() => undefined);
    return await this.ensureActivePage(session);
  }

  private async ensureSafeFinalUrl(session: BrowserSessionRecord, page: Page): Promise<void> {
    session.operation.check();
    const currentUrl = trimToUndefined(page.url());
    if (!currentUrl) {
      return;
    }
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      session.previewOriginGrant = undefined;
      return;
    }
    if (!/^https?:$/i.test(url.protocol)) {
      session.previewOriginGrant = undefined;
      return;
    }
    await this.ensureSafeBrowserTarget(url, session.previewOriginGrant);
    session.operation.check();
    this.clearPreviewGrantIfLeavingOrigin(session, url);
  }

  private async targetLocator(
    page: Page,
    action: BrowserElementAction,
    timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<Locator> {
    operation.check();
    const ref = trimToUndefined(action.ref);
    const target = ref ? buildRefSelector(ref) : trimToUndefined(action.selector);
    if (!target) {
      throw new ToolError(`browser ${action.action} requires ref or selector.`);
    }
    const locator = page.locator(target).first();
    try {
      await locator.waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      operation.check();
      return locator;
    } catch {
      operation.check();
      if (ref) {
        throw new ToolError(`browser could not find ref ${ref}. Take a fresh snapshot first.`);
      }
      throw new ToolError(`browser could not find selector ${target}.`);
    }
  }

  private async takeSnapshot(
    session: BrowserSessionRecord,
    params: {
      mode: BrowserSnapshotMode;
      changes?: BrowserSnapshotChanges | null;
      timeoutMs?: number;
    },
  ): Promise<BrowserSnapshotCapture> {
    const page = await this.ensureActivePage(session);
    session.operation.check();
    const timeoutMs = Math.max(1, Math.floor(params.timeoutMs ?? this.actionTimeoutMs));
    const raw = await withTimeout(
      page.evaluate(
        runSnapshotScriptInPage,
        {
          script: getSnapshotScript(),
          maxChars: this.maxSnapshotChars,
        },
      ),
      timeoutMs,
      "browser snapshot",
      {
        action: "snapshot",
        scope: session.scope,
      },
    );
    session.operation.check();
    const normalized = normalizeSnapshotResult(raw, {
      maxChars: this.maxSnapshotChars,
      mode: params.mode,
      changes: params.changes,
    });
    return {
      snapshot: normalized.snapshot,
      text: normalized.text,
      truncated: normalized.truncated,
      elementCount: normalized.snapshot.elements.length,
    };
  }

  private async captureActionBaseline(session: BrowserSessionRecord, timeoutMs: number): Promise<BrowserActionBaseline> {
    const page = await this.ensureActivePage(session);
    session.operation.check();
    const snapshot = await this.takeSnapshot(session, {
      mode: "compact",
      timeoutMs,
    });
    return {
      page,
      snapshot: snapshot.snapshot,
    };
  }

  private renderSnapshotCapture(
    capture: BrowserSnapshotCapture,
    mode: BrowserSnapshotMode,
    changes?: BrowserSnapshotChanges | null,
  ): BrowserSnapshotCapture {
    const rendered = renderBrowserSnapshot(capture.snapshot, {
      maxChars: this.maxSnapshotChars,
      mode,
      changes,
    });
    return {
      ...capture,
      text: rendered.text,
      truncated: rendered.truncated,
    };
  }

  private buildSnapshotDetails(
    session: BrowserSessionRecord,
    action: BrowserAction["action"],
    capture: BrowserSnapshotCapture,
    mode: BrowserSnapshotMode,
    changes?: BrowserSnapshotChanges | null,
  ): JsonObject {
    return {
      action,
      url: capture.snapshot.url,
      title: capture.snapshot.title,
      truncated: capture.truncated,
      elementCount: capture.elementCount,
      scope: session.scope,
      ...buildSessionDeviceResultDetails(session),
      snapshotMode: mode,
      signals: [...capture.snapshot.signals],
      elements: capture.snapshot.elements.map((element) => ({...element})),
      externalContent: buildBrowserExternalContentDetails("snapshot"),
      ...(changes ? {changes: toJsonSnapshotChanges(changes)} : {}),
    };
  }

  private async buildSnapshotPayload(
    session: BrowserSessionRecord,
    action: BrowserAction["action"],
    mode: BrowserSnapshotMode,
    changes?: BrowserSnapshotChanges | null,
    capture?: BrowserSnapshotCapture,
    timeoutMs?: number,
  ): Promise<ToolResultPayload> {
    const snapshot = capture
      ? this.renderSnapshotCapture(capture, mode, changes)
      : await this.takeSnapshot(session, {
          mode,
          changes,
          timeoutMs,
        });
    return {
      content: [
        {
          type: "text",
          text: snapshot.text,
        },
      ],
      details: this.buildSnapshotDetails(session, action, snapshot, mode, changes),
    };
  }

  private async buildChangedActionSnapshotPayload<TContext extends BrowserRuntimeContext>(
    run: RunContext<TContext>,
    session: BrowserSessionRecord,
    action: BrowserAction,
    baseline: BrowserActionBaseline,
    settledPage: Page,
    snapshotMode: BrowserSnapshotMode,
    timeoutMs: number,
  ): Promise<ToolResultPayload> {
    await this.ensureSafeFinalUrl(session, settledPage);
    this.emitProgress(run, session.operation, "snapshotting", {action: action.action});
    const capture = await this.takeSnapshot(session, {
      mode: snapshotMode,
      timeoutMs,
    });
    const changes = buildSnapshotChanges({
      before: baseline.snapshot,
      after: capture.snapshot,
      action,
      pageSwitched: baseline.page !== settledPage,
    });
    return await this.buildSnapshotPayload(session, action.action, snapshotMode, changes, capture);
  }

  private async buildEvaluatePayload(
    session: BrowserSessionRecord,
    action: Extract<BrowserAction, {action: "evaluate"}>,
  ): Promise<ToolResultPayload> {
    const page = await this.ensureActivePage(session);
    session.operation.check();
    const raw = await withTimeout(
      page.evaluate(
        runEvaluateScriptInPage,
        {
          arg: action.arg,
          userScript: action.script,
          runnerSource: getEvaluateScriptSource(),
        },
      ),
      action.timeoutMs ?? this.actionTimeoutMs,
      "browser evaluate",
    );
    session.operation.check();
    const serialized = trimToUndefined(raw.json) ?? trimToUndefined(raw.text);
    if (!serialized) {
      return {
        content: [
          {
            type: "text",
            text: "browser evaluate returned no value; add an explicit `return` if you want a result.",
          },
        ],
        details: {
          action: "evaluate",
          scope: session.scope,
          ...buildSessionDeviceResultDetails(session),
          url: page.url(),
          result: null,
          truncated: false,
        } satisfies JsonObject,
      };
    }
    const truncated = truncateTextWithStatus(serialized, this.maxEvaluateResultChars);
    return {
      content: [
        {
          type: "text",
          text: wrapBrowserExternalContent(truncated.text, {kind: "evaluate"}),
        },
      ],
      details: {
        action: "evaluate",
        scope: session.scope,
        ...buildSessionDeviceResultDetails(session),
        url: page.url(),
        truncated: truncated.truncated,
        result: truncated.text,
        externalContent: buildBrowserExternalContentDetails("evaluate"),
      } satisfies JsonObject,
    };
  }

  private async installScreenshotLabels(page: Page): Promise<void> {
    await page.evaluate((input: unknown) => {
      const payload = input as {refAttribute?: unknown};
      const refAttribute = typeof payload.refAttribute === "string"
        ? payload.refAttribute
        : "data-runtime-ref";
      const root = globalThis as {document?: any};
      const document = root.document;
      if (!document?.body) {
        return;
      }

      const overlayId = "runtime-browser-ref-overlays";
      document.getElementById(overlayId)?.remove();

      const overlayRoot = document.createElement("div");
      overlayRoot.id = overlayId;
      overlayRoot.setAttribute("aria-hidden", "true");
      overlayRoot.style.position = "fixed";
      overlayRoot.style.inset = "0";
      overlayRoot.style.pointerEvents = "none";
      overlayRoot.style.zIndex = "2147483647";

      type ScreenshotLabelTarget = {
        getAttribute(name: string): string | null;
        getBoundingClientRect(): {left: number; top: number; width: number; height: number};
      };
      const targets = Array.from(document.querySelectorAll(`[${refAttribute}]`)) as ScreenshotLabelTarget[];
      for (const element of targets) {
        const ref = element.getAttribute(refAttribute);
        if (!ref) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        const box = document.createElement("div");
        box.style.position = "fixed";
        box.style.left = `${Math.max(0, rect.left)}px`;
        box.style.top = `${Math.max(0, rect.top)}px`;
        box.style.width = `${Math.max(8, rect.width)}px`;
        box.style.height = `${Math.max(8, rect.height)}px`;
        box.style.outline = "2px solid #ff6a00";
        box.style.outlineOffset = "1px";
        box.style.boxSizing = "border-box";

        const label = document.createElement("div");
        label.textContent = ref;
        label.style.position = "absolute";
        label.style.left = "0";
        label.style.top = "0";
        label.style.transform = "translateY(-100%)";
        label.style.background = "#ff6a00";
        label.style.color = "#111";
        label.style.font = "600 12px/1.2 monospace";
        label.style.padding = "2px 4px";
        label.style.borderRadius = "4px";
        label.style.whiteSpace = "nowrap";

        box.appendChild(label);
        overlayRoot.appendChild(box);
      }

      document.body.appendChild(overlayRoot);
    }, {
      refAttribute: SNAPSHOT_REF_ATTRIBUTE,
    });
  }

  private async removeScreenshotLabels(page: Page): Promise<void> {
    await page.evaluate(() => {
      const root = globalThis as {document?: any};
      root.document?.getElementById("runtime-browser-ref-overlays")?.remove();
    }).catch(() => undefined);
  }

  private async buildScreenshotPayload(
    session: BrowserSessionRecord,
    action: Extract<BrowserAction, {action: "screenshot"}>,
    timeoutMs: number,
  ): Promise<ToolResultPayload> {
    const page = await this.ensureActivePage(session);
    session.operation.check();
    const target = trimToUndefined(action.ref) || trimToUndefined(action.selector);
    if (target && action.fullPage) {
      throw new ToolError("browser screenshot does not support fullPage with ref or selector.");
    }
    if (action.labels && target) {
      throw new ToolError("browser screenshot labels are only supported for whole-page screenshots.");
    }

    let labeledSnapshot: BrowserSnapshotCapture | null = null;
    if (action.labels) {
      labeledSnapshot = await this.takeSnapshot(session, {
        mode: "compact",
        timeoutMs,
      });
    }

    let bytes: Buffer | Uint8Array;
    try {
      if (action.labels) {
        session.operation.check();
        await this.installScreenshotLabels(page);
        session.operation.check();
      }
      if (target) {
        const locator = await this.targetLocator(page, action, timeoutMs, session.operation);
        session.operation.check();
        bytes = await locator.screenshot({timeout: timeoutMs});
      } else {
        session.operation.check();
        bytes = await page.screenshot({fullPage: action.fullPage === true, timeout: timeoutMs});
      }
    } finally {
      if (action.labels && !session.operation.error) {
        await this.removeScreenshotLabels(page);
      }
    }
    return await buildBrowserScreenshotArtifactPayload({
      session,
      page,
      bytes,
      labels: action.labels === true,
      labeledSnapshot,
      writeArtifact: (filePath, bytes) => this.writeArtifact(session, filePath, bytes),
    });
  }

  private async buildPdfPayload(
    session: BrowserSessionRecord,
    timeoutMs: number,
  ): Promise<ToolResultPayload> {
    const page = await this.ensureActivePage(session);
    session.operation.check();
    const pdf = await withTimeout(page.pdf(), timeoutMs, "browser pdf");
    return await buildBrowserPdfArtifactPayload({
      session,
      page,
      bytes: pdf,
      writeArtifact: (filePath, bytes) => this.writeArtifact(session, filePath, bytes),
    });
  }

  private ownSession(operation: BrowserOperation, session: BrowserSessionRecord): void {
    operation.session = session;
    operation.browser = session.browser;
    operation.context = session.context;
    session.operation = operation;
  }

  private async closeRecord(session: BrowserSessionRecord): Promise<void> {
    if (this.sessions.get(session.scopeKey) === session) {
      this.sessions.delete(session.scopeKey);
    }
    try {
      await this.persistStorageState(session).catch(() => undefined);
    } finally {
      await session.context.close().catch(() => undefined);
      await session.browser.close().catch(() => undefined);
    }
  }

  async closeSession(scopeKey: string): Promise<void> {
    const admission = this.reserveScope(scopeKey);
    try {
      await admission.ready;
      const session = this.sessions.get(scopeKey);
      if (session) await this.closeRecord(session);
    } finally {
      admission.release();
    }
  }

  async reapExpiredSessions(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()]
      .filter((session) =>
        now - session.lastUsedAtMs >= this.sessionIdleTtlMs
        || now - session.createdAtMs >= this.sessionMaxAgeMs,
      );
    for (const session of expired) {
      const admission = this.reserveScope(session.scopeKey);
      try {
        await admission.ready;
        if (this.sessions.get(session.scopeKey) === session && (
          this.now() - session.lastUsedAtMs >= this.sessionIdleTtlMs
          || this.now() - session.createdAtMs >= this.sessionMaxAgeMs
        )) {
          await this.closeRecord(session);
        }
      } finally {
        admission.release();
      }
    }
  }

  async close(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const sessionKeys = new Set([...this.sessions.keys(), ...this.admission.keys()]);
    for (const scopeKey of sessionKeys) {
      await this.closeSession(scopeKey);
    }
  }

  async handle<TContext extends BrowserRuntimeContext>(
    action: BrowserAction,
    run: RunContext<TContext>,
    previewOriginGrant?: BrowserPreviewOriginGrant,
  ): Promise<ToolResultPayload> {
    await this.ensureStarted();

    const scope = normalizeBrowserSessionScopeKey(resolveSessionContext(run.context), action.deviceProfile);
    const timeoutMs = this.resolveActionTimeout(action);
    return await this.runWithActionTimeout(
      action,
      scope.key,
      timeoutMs,
      run.signal,
      (operation) => this.handleAction(action, run, scope, timeoutMs, operation, previewOriginGrant),
    );
  }

  private async handleAction<TContext extends BrowserRuntimeContext>(
    action: BrowserAction,
    run: RunContext<TContext>,
    scope: BrowserResolvedSessionScope,
    timeoutMs: number,
    operation: BrowserOperation,
    previewOriginGrant?: BrowserPreviewOriginGrant,
  ): Promise<ToolResultPayload> {
    const snapshotMode = "snapshotMode" in action ? action.snapshotMode ?? "compact" : "compact";
    const persistent = scope.scope !== "ephemeral";
    const scopeKey = scope.key;

    if (action.action === "close") {
      this.emitProgress(run, operation, "closing", {scope: scope.scope, scopeKey, deviceProfile: scope.deviceProfile});
      if (!persistent) {
        return {
          content: [{type: "text", text: "No persistent browser session to close."}],
          details: {action: "close", scope: scope.scope, deviceProfile: scope.deviceProfile} satisfies JsonObject,
        };
      }
      const existing = this.sessions.get(scopeKey);
      const hadSession = Boolean(existing);
      if (existing) {
        this.ownSession(operation, existing);
        await this.closeRecord(existing);
        operation.check();
      }
      return {
        content: [{
          type: "text",
          text: hadSession ? "Closed the browser session." : "No active browser session to close.",
        }],
        details: {action: "close", scope: scope.scope, deviceProfile: scope.deviceProfile, closed: hadSession} satisfies JsonObject,
      };
    }

    if (action.action === "navigate") {
      this.emitProgress(run, operation, "navigating", {
        scope: scope.scope,
        deviceProfile: scope.deviceProfile,
        url: action.url,
      });
      await this.ensureSafeBrowserTarget(new URL(action.url), previewOriginGrant);
      operation.check();
    }

    let session: BrowserSessionRecord | null = null;
    try {
      if (!this.sessions.has(scopeKey)) {
        this.emitProgress(run, operation, "starting", {scope: scope.scope, scopeKey, deviceProfile: scope.deviceProfile});
      }
      this.emitProgress(run, operation, "connecting", {scope: scope.scope, scopeKey, deviceProfile: scope.deviceProfile});
      session = await this.resolveSession(scope, run, timeoutMs, operation);
      operation.check();
      if (action.action === "navigate") {
        session.previewOriginGrant = previewOriginGrant;
      }
      const page = await this.ensureActivePage(session);
      operation.check();

      switch (action.action) {
        case "snapshot":
          this.emitProgress(run, operation, "snapshotting", {action: "snapshot"});
          return await this.buildSnapshotPayload(session, "snapshot", snapshotMode, undefined, undefined, timeoutMs);
        case "evaluate":
          this.emitProgress(run, operation, "evaluating", {action: "evaluate"});
          return await this.buildEvaluatePayload(session, action);
        case "screenshot":
          this.emitProgress(run, operation, "capturing", {action: "screenshot"});
          return await this.buildScreenshotPayload(session, action, timeoutMs);
        case "pdf":
          this.emitProgress(run, operation, "capturing", {action: "pdf"});
          return await this.buildPdfPayload(session, timeoutMs);
      }

      const baseline = await this.captureActionBaseline(session, timeoutMs);
      operation.check();
      switch (action.action) {
        case "navigate": {
          await baseline.page.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          break;
        }
        case "click": {
          const target = formatActionTarget(action);
          this.emitProgress(run, operation, "acting", {
            action: "click",
            ...(target ? {target} : {}),
          });
          const locator = await this.targetLocator(page, action, timeoutMs, session.operation);
          operation.check();
          await locator.click({
            timeout: timeoutMs,
          });
          break;
        }
        case "type": {
          const target = formatActionTarget(action);
          this.emitProgress(run, operation, "acting", {
            action: "type",
            ...(target ? {target} : {}),
          });
          const locator = await this.targetLocator(page, action, timeoutMs, session.operation);
          operation.check();
          try {
            await locator.fill(action.text, {
              timeout: timeoutMs,
            });
          } catch {
            operation.check();
            await locator.click({
              timeout: timeoutMs,
            });
            operation.check();
            await page.keyboard.insertText(action.text);
          }
          operation.check();
          if (action.submit) {
            await locator.press("Enter", {
              timeout: timeoutMs,
            }).catch(async () => {
              operation.check();
              await withTimeout(page.keyboard.press("Enter"), timeoutMs, "browser key press");
            });
          }
          break;
        }
        case "press": {
          this.emitProgress(run, operation, "acting", {action: "press", key: action.key});
          if (trimToUndefined(action.ref) || trimToUndefined(action.selector)) {
            const locator = await this.targetLocator(page, action, timeoutMs, operation);
            operation.check();
            await locator.press(action.key, {
              timeout: timeoutMs,
            });
          } else {
            await withTimeout(page.keyboard.press(action.key), timeoutMs, "browser key press");
          }
          break;
        }
        case "select": {
          const target = formatActionTarget(action);
          this.emitProgress(run, operation, "acting", {
            action: "select",
            ...(target ? {target} : {}),
          });
          const values = Array.isArray(action.values)
            ? action.values
            : typeof action.value === "string"
              ? [action.value]
              : [];
          const locator = await this.targetLocator(page, action, timeoutMs, operation);
          operation.check();
          await locator.selectOption(
            values.map((value) => ({value})),
            {
              timeout: timeoutMs,
            },
          );
          break;
        }
        case "wait": {
          this.emitProgress(run, operation, "acting", {action: buildWaitLabel(action)});
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
          break;
        }
        default:
          throw new ToolError("browser reached an invalid action.");
      }
      operation.check();
      const settledPage = await this.settlePage(session, timeoutMs);
      return await this.buildChangedActionSnapshotPayload(
        run,
        session,
        action,
        baseline,
        settledPage,
        snapshotMode,
        timeoutMs,
      );
    } finally {
      if (session && !operation.error) {
        session.lastUsedAtMs = this.now();
        if (persistent) {
          await this.persistStorageState(session).catch(() => undefined);
        }
      }
      if (!persistent && session && !operation.error) {
        await this.closeRecord(session).catch(() => undefined);
      }
    }
  }
}
