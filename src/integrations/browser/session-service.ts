import {randomUUID} from "node:crypto";
import {mkdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";

import {
    type Browser,
    type BrowserContext,
    type BrowserContextOptions,
    chromium,
    type LaunchOptions,
    type Locator,
    type Page
} from "playwright-core";

import {resolveDataDir} from "../../app/runtime/data-dir.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {pathExists} from "../../lib/fs.js";
import {trimToUndefined, truncateTextWithStatus} from "../../lib/strings.js";
import {
    buildRefSelector,
    getSnapshotScript,
    normalizeSnapshotResult,
    renderBrowserSnapshot,
    SNAPSHOT_REF_ATTRIBUTE,
    type SnapshotScriptResult,
} from "../../panda/tools/browser-snapshot.js";
import {buildBrowserExternalContentDetails, wrapBrowserExternalContent,} from "../../panda/tools/browser-output.js";
import type {
    BrowserAction,
    BrowserProgressStatus,
    BrowserSessionScope,
    BrowserSnapshot,
    BrowserSnapshotChanges,
    BrowserSnapshotElement,
    BrowserSnapshotMode,
} from "../../panda/tools/browser-types.js";
import {defaultLookupHostname, type LookupHostname, resolveSafeHttpTarget,} from "../../panda/tools/safe-web-target.js";
import type {BrowserPreviewOriginGrant} from "./protocol.js";
import {normalizeBrowserLabelValue, normalizeBrowserScopeKey, safeAgentKey,} from "./shared.js";

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
  artifactDir: string;
  storageStatePath?: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  disconnected: boolean;
  previewOriginGrant?: BrowserPreviewOriginGrant;
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

type BrowserSnapshotCapture = {
  snapshot: BrowserSnapshot;
  text: string;
  truncated: boolean;
  elementCount: number;
};

type BrowserActionBaseline = {
  page: Page;
  snapshot: BrowserSnapshot;
};

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

function normalizeBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function resolveBrowserRunnerRoot(dataDir: string | undefined, env: NodeJS.ProcessEnv): string {
  const configured = trimToUndefined(dataDir);
  if (configured) {
    return path.resolve(configured);
  }

  return path.join(resolveDataDir(env), DEFAULT_BROWSER_RUNNER_SUBDIR);
}

function readAllowedPrivateHostnames(
  env: NodeJS.ProcessEnv,
  explicit: readonly string[] | undefined,
): readonly string[] {
  if (explicit?.length) {
    return explicit;
  }

  const raw = trimToUndefined(env.BROWSER_ALLOW_PRIVATE_HOSTS);
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => trimToUndefined(value))
    .filter((value): value is string => Boolean(value));
}

function browserNetworkProtocols(): readonly string[] {
  return ["http:", "https:", "ws:", "wss:"];
}

function browserNavigationProtocols(): readonly string[] {
  return ["http:", "https:"];
}

function isBrowserNetworkProtocol(protocol: string): boolean {
  return browserNetworkProtocols().includes(protocol.toLowerCase());
}

function isWebSocketProtocol(protocol: string): boolean {
  return ["ws:", "wss:"].includes(protocol.toLowerCase());
}

function websocketOriginForHttpOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function buildPreviewPrivateOrigins(grant: BrowserPreviewOriginGrant | undefined): string[] {
  if (!grant) {
    return [];
  }

  const websocketOrigin = websocketOriginForHttpOrigin(grant.resolvedOrigin);
  return [
    grant.resolvedOrigin,
    ...(websocketOrigin ? [websocketOrigin] : []),
  ];
}

function buildBrowserContextOptions(storageStatePath?: string): BrowserContextOptions {
  return {
    serviceWorkers: "block",
    ...(storageStatePath ? {storageState: storageStatePath} : {}),
  };
}

function isMainFrameNavigationRequest(request: {
  isNavigationRequest?: () => boolean;
  resourceType?: () => string;
  frame?: () => {parentFrame?: () => unknown};
}): boolean {
  if (request.isNavigationRequest?.() !== true || request.resourceType?.() !== "document") {
    return false;
  }
  try {
    return request.frame?.().parentFrame?.() === null;
  } catch {
    return false;
  }
}

function normalizeScopeKey(context: DefaultAgentSessionContext): {scope: BrowserSessionScope; key: string} {
  return normalizeBrowserScopeKey(context);
}

function resolveSessionContext(context: DefaultAgentSessionContext | undefined): DefaultAgentSessionContext {
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
  context: DefaultAgentSessionContext,
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

function summarizeSnapshotElement(element: BrowserSnapshotElement | undefined): string | undefined {
  if (!element) {
    return undefined;
  }

  const parts: string[] = [];
  if (element.text) {
    parts.push(`text="${element.text}"`);
  }
  if (element.value) {
    parts.push(`value="${element.value}"`);
  }
  if (element.checked !== undefined) {
    parts.push(element.checked ? "checked" : "unchecked");
  }
  if (element.selected !== undefined) {
    parts.push(element.selected ? "selected" : "unselected");
  }
  if (element.expanded !== undefined) {
    parts.push(element.expanded ? "expanded" : "collapsed");
  }
  if (element.pressed !== undefined) {
    parts.push(element.pressed ? "pressed" : "not-pressed");
  }
  if (element.invalid) {
    parts.push("invalid");
  }
  if (element.readonly) {
    parts.push("readonly");
  }
  if (element.href) {
    parts.push(`href="${element.href}"`);
  }
  if (parts.length === 0) {
    parts.push(element.role || element.tag || "element");
  }
  return parts.join(", ");
}

function diffSnapshotElementFields(
  before: BrowserSnapshotElement | undefined,
  after: BrowserSnapshotElement | undefined,
): readonly string[] {
  if (!before && !after) {
    return [];
  }
  if (!before) {
    return ["appeared"];
  }
  if (!after) {
    return ["disappeared"];
  }

  const changed: string[] = [];
  const fields: Array<keyof BrowserSnapshotElement> = [
    "text",
    "value",
    "checked",
    "selected",
    "expanded",
    "pressed",
    "disabled",
    "required",
    "invalid",
    "readonly",
    "href",
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      changed.push(field);
    }
  }
  return changed;
}

function resolveTargetSnapshotElement(
  snapshot: BrowserSnapshot,
  action: BrowserAction,
): BrowserSnapshotElement | undefined {
  if (!("ref" in action)) {
    return undefined;
  }
  const ref = trimToUndefined(action.ref);
  if (!ref) {
    return undefined;
  }
  return snapshot.elements.find((element) => element.ref === ref);
}

function buildSnapshotChanges(params: {
  before?: BrowserSnapshot | null;
  after: BrowserSnapshot;
  action: BrowserAction;
  pageSwitched: boolean;
}): BrowserSnapshotChanges | undefined {
  const before = params.before ?? null;
  const after = params.after;
  const changes: BrowserSnapshotChanges = {};

  if (params.pageSwitched) {
    changes.pageSwitched = true;
  }

  if (before && before.url !== after.url) {
    changes.urlChanged = {
      before: before.url,
      after: after.url,
    };
  }

  if (before && before.title !== after.title) {
    changes.titleChanged = {
      before: before.title,
      after: after.title,
    };
  }

  const beforeSignals = new Set(before?.signals ?? []);
  const afterSignals = new Set(after.signals);
  const signalsAdded = [...afterSignals].filter((signal) => !beforeSignals.has(signal));
  const signalsRemoved = [...beforeSignals].filter((signal) => !afterSignals.has(signal));
  if (signalsAdded.length > 0) {
    changes.signalsAdded = signalsAdded;
  }
  if (signalsRemoved.length > 0) {
    changes.signalsRemoved = signalsRemoved;
  }

  const beforeHasDialog = beforeSignals.has("dialog");
  const afterHasDialog = afterSignals.has("dialog");
  if (!beforeHasDialog && afterHasDialog) {
    changes.dialogAppeared = true;
  }
  if (beforeHasDialog && !afterHasDialog) {
    changes.dialogDismissed = true;
  }

  const beforeTarget = before ? resolveTargetSnapshotElement(before, params.action) : undefined;
  const afterTarget = resolveTargetSnapshotElement(after, params.action);
  const targetFieldChanges = diffSnapshotElementFields(beforeTarget, afterTarget);
  if (targetFieldChanges.length > 0) {
    const beforeSummary = summarizeSnapshotElement(beforeTarget);
    const afterSummary = summarizeSnapshotElement(afterTarget);
    changes.target = {
      ...("ref" in params.action && trimToUndefined(params.action.ref)
        ? {ref: params.action.ref?.trim()}
        : {}),
      ...("selector" in params.action && trimToUndefined(params.action.selector)
        ? {selector: params.action.selector?.trim()}
        : {}),
      ...(beforeSummary ? {before: beforeSummary} : {}),
      ...(afterSummary ? {after: afterSummary} : {}),
      changed: targetFieldChanges,
    };
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

function toJsonSnapshotChanges(changes: BrowserSnapshotChanges): JsonObject {
  return {
    ...(changes.pageSwitched ? {pageSwitched: true} : {}),
    ...(changes.urlChanged
      ? {
          urlChanged: {
            before: changes.urlChanged.before,
            after: changes.urlChanged.after,
          },
        }
      : {}),
    ...(changes.titleChanged
      ? {
          titleChanged: {
            ...(changes.titleChanged.before !== undefined ? {before: changes.titleChanged.before} : {}),
            ...(changes.titleChanged.after !== undefined ? {after: changes.titleChanged.after} : {}),
          },
        }
      : {}),
    ...(changes.dialogAppeared ? {dialogAppeared: true} : {}),
    ...(changes.dialogDismissed ? {dialogDismissed: true} : {}),
    ...(changes.signalsAdded ? {signalsAdded: [...changes.signalsAdded]} : {}),
    ...(changes.signalsRemoved ? {signalsRemoved: [...changes.signalsRemoved]} : {}),
    ...(changes.target
      ? {
          target: {
            ...(changes.target.ref ? {ref: changes.target.ref} : {}),
            ...(changes.target.selector ? {selector: changes.target.selector} : {}),
            ...(changes.target.before !== undefined ? {before: changes.target.before} : {}),
            ...(changes.target.after !== undefined ? {after: changes.target.after} : {}),
            ...(changes.target.changed ? {changed: [...changes.target.changed]} : {}),
          },
        }
      : {}),
  };
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
  private readonly invalidatedScopeVersions = new Map<string, number>();
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

  private emitProgress<TContext extends DefaultAgentSessionContext>(
    run: RunContext<TContext>,
    status: BrowserProgressStatus,
    extra: JsonObject = {},
  ): void {
    run.emitToolProgress({
      status,
      ...extra,
    });
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

  private readScopeVersion(scopeKey: string): number {
    return this.invalidatedScopeVersions.get(scopeKey) ?? 0;
  }

  private invalidateScope(scopeKey: string): void {
    this.invalidatedScopeVersions.set(scopeKey, this.readScopeVersion(scopeKey) + 1);
  }

  private isScopeInvalidated(scopeKey: string, version: number): boolean {
    return this.readScopeVersion(scopeKey) !== version;
  }

  private async runWithActionTimeout<T>(
    action: BrowserAction,
    scopeKey: string,
    timeoutMs: number,
    operation: (scopeVersion: number) => Promise<T>,
  ): Promise<T> {
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const scopeVersion = this.readScopeVersion(scopeKey);
    const actionPromise = operation(scopeVersion);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(buildTimeoutError(`browser action ${action.action}`, timeoutMs, {
          action: action.action,
        }));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([actionPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut || isTimeoutToolError(error)) {
        this.invalidateScope(scopeKey);
        // Remove the dirty session immediately; the async close may continue in
        // the background, but future actions must not reuse a wedged page.
        void this.closeSession(scopeKey).catch(() => undefined);
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async createBrowserContext(
    browser: Browser,
    storageStatePath?: string,
  ): Promise<BrowserContext> {
    if (!storageStatePath || !(await pathExists(storageStatePath))) {
      return await browser.newContext(buildBrowserContextOptions());
    }

    try {
      return await browser.newContext(buildBrowserContextOptions(storageStatePath));
    } catch {
      await rm(storageStatePath, {force: true}).catch(() => undefined);
      return await browser.newContext(buildBrowserContextOptions());
    }
  }

  private async persistStorageState(session: BrowserSessionRecord | null | undefined): Promise<void> {
    if (!session?.storageStatePath || session.scope !== "thread") {
      return;
    }
    await mkdir(path.dirname(session.storageStatePath), {recursive: true});
    await session.context.storageState({
      path: session.storageStatePath,
    }).catch(() => undefined);
  }

  private async startSession<TContext extends DefaultAgentSessionContext>(
    scope: {scope: BrowserSessionScope; key: string},
    run: RunContext<TContext>,
    _timeoutMs: number,
    scopeVersion: number,
  ): Promise<BrowserSessionRecord> {
    const startedAtMs = this.now();
    const sessionRoot = path.join(
      resolveBrowserSessionRoot(resolveSessionContext(run.context), this.dataDir, this.env),
      "sessions",
      normalizeBrowserLabelValue(scope.key),
    );
    const artifactDir = path.join(sessionRoot, "artifacts");
    const storageStatePath = scope.scope === "thread"
      ? path.join(sessionRoot, "storage-state.json")
      : undefined;
    await mkdir(artifactDir, {recursive: true});

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let session: BrowserSessionRecord | null = null;
    try {
      browser = await this.launchBrowserImpl(this.launchOptions);
      context = await this.createBrowserContext(browser, storageStatePath);
      await context.route("**/*", async (route) => {
        const request = route.request();
        const requestUrl = trimToUndefined(request.url());
        if (!requestUrl) {
          await route.continue();
          return;
        }
        try {
          const url = new URL(requestUrl);
          if (!isBrowserNetworkProtocol(url.protocol)) {
            await route.continue();
            return;
          }
          if (session && isMainFrameNavigationRequest(request)) {
            this.clearPreviewGrantIfLeavingOrigin(session, url);
          }
          await this.ensureSafeBrowserTarget(url, session?.previewOriginGrant, browserNetworkProtocols());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket?.("**/*", async (ws) => {
        const requestUrl = trimToUndefined(ws.url());
        if (!requestUrl) {
          await ws.close({code: 1008, reason: "Blocked by browser policy"}).catch(() => undefined);
          return;
        }
        try {
          const url = new URL(requestUrl);
          if (!isWebSocketProtocol(url.protocol)) {
            await ws.close({code: 1008, reason: "Blocked by browser policy"}).catch(() => undefined);
            return;
          }
          await this.ensureSafeBrowserTarget(url, session?.previewOriginGrant, ["ws:", "wss:"]);
          ws.connectToServer();
        } catch {
          await ws.close({code: 1008, reason: "Blocked by browser policy"}).catch(() => undefined);
        }
      });
      const page = await context.newPage();

      session = {
        scopeKey: scope.key,
        scope: scope.scope,
        browser,
        context,
        page,
        artifactDir,
        storageStatePath,
        createdAtMs: startedAtMs,
        lastUsedAtMs: startedAtMs,
        disconnected: false,
      };
      const createdSession = session;
      context.on?.("page", (nextPage) => {
        void this.switchToPage(createdSession, nextPage).catch(() => undefined);
      });
      browser.on?.("disconnected", () => {
        createdSession.disconnected = true;
      });
      if (this.isScopeInvalidated(scope.key, scopeVersion)) {
        throw buildTimeoutError("browser session startup", _timeoutMs, {
          action: "start",
          scope: scope.scope,
        });
      }
      this.sessions.set(scope.key, session);
      return session;
    } catch (error) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
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

  private async resolveSession<TContext extends DefaultAgentSessionContext>(
    scope: {scope: BrowserSessionScope; key: string},
    run: RunContext<TContext>,
    timeoutMs: number,
    scopeVersion: number,
  ): Promise<BrowserSessionRecord> {
    const existing = this.sessions.get(scope.key);
    if (!existing) {
      return await this.startSession(scope, run, timeoutMs, scopeVersion);
    }
    const now = this.now();
    if (
      existing.disconnected ||
      now - existing.lastUsedAtMs >= this.sessionIdleTtlMs ||
      now - existing.createdAtMs >= this.sessionMaxAgeMs
    ) {
      await this.closeSession(scope.key).catch(() => undefined);
      return await this.startSession(scope, run, timeoutMs, scopeVersion);
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

  private async ensureSafeFinalUrl(session: BrowserSessionRecord, page: Page): Promise<void> {
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
    this.clearPreviewGrantIfLeavingOrigin(session, url);
  }

  private async targetLocator(
    page: Page,
    action: BrowserElementAction,
    timeoutMs: number,
  ): Promise<Locator> {
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
    params: {
      mode: BrowserSnapshotMode;
      changes?: BrowserSnapshotChanges | null;
      timeoutMs?: number;
    },
  ): Promise<BrowserSnapshotCapture> {
    const page = await this.ensureActivePage(session);
    const timeoutMs = Math.max(1, Math.floor(params.timeoutMs ?? this.actionTimeoutMs));
    const raw = await withTimeout(
      page.evaluate(
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
      ) as Promise<SnapshotScriptResult>,
      timeoutMs,
      "browser snapshot",
      {
        action: "snapshot",
        scope: session.scope,
      },
    );
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

      for (const element of Array.from(document.querySelectorAll(`[${refAttribute}]`)) as any[]) {
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
        await this.installScreenshotLabels(page);
      }
      bytes = target
        ? await (await this.targetLocator(page, action, timeoutMs)).screenshot({
            timeout: timeoutMs,
          })
        : await page.screenshot({
            fullPage: action.fullPage === true,
            timeout: timeoutMs,
          });
    } finally {
      if (action.labels) {
        await this.removeScreenshotLabels(page);
      }
    }
    const buffer = normalizeBuffer(bytes);
    const filePath = path.join(session.artifactDir, `${Date.now()}-${randomUUID()}.png`);
    await writeFile(filePath, buffer);
    const title = await page.title().catch(() => "");
    const textLines = [
      `Browser screenshot saved to ${filePath}`,
      ...(trimToUndefined(title) ? [`Page title: ${title}`] : []),
      `Page URL: ${page.url()}`,
    ];
    const text = action.labels && labeledSnapshot
      ? `${textLines.join("\n")}\n\n${labeledSnapshot.text}`
      : textLines.join("\n");
    const details = withArtifactDetails({
      action: "screenshot",
      scope: session.scope,
      path: filePath,
      mimeType: "image/png",
      bytes: buffer.length,
      url: page.url(),
      title,
      ...(action.labels ? {labels: true} : {}),
      ...(labeledSnapshot
        ? {
            snapshotMode: "compact",
            truncated: labeledSnapshot.truncated,
            elementCount: labeledSnapshot.elementCount,
            signals: [...labeledSnapshot.snapshot.signals],
            elements: labeledSnapshot.snapshot.elements.map((element) => ({...element})),
            externalContent: buildBrowserExternalContentDetails("snapshot"),
          }
        : {}),
    }, {
      kind: "image",
      source: "browser",
      path: filePath,
      mimeType: "image/png",
      bytes: buffer.length,
    });
    return buildBrowserImagePayload({
      bytes: buffer,
      path: filePath,
      text,
      details,
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
            ...(trimToUndefined(title) ? [`Page title: ${title}`] : []),
            `Page URL: ${page.url()}`,
          ].join("\n"),
        },
      ],
      details: withArtifactDetails({
        action: "pdf",
        scope: session.scope,
        path: filePath,
        mimeType: "application/pdf",
        bytes: buffer.length,
        url: page.url(),
        title,
      } satisfies JsonObject, {
        kind: "pdf",
        source: "browser",
        path: filePath,
        mimeType: "application/pdf",
        bytes: buffer.length,
      }),
    };
  }

  async closeSession(scopeKey: string): Promise<void> {
    const session = this.sessions.get(scopeKey);
    if (!session) {
      return;
    }
    this.sessions.delete(scopeKey);
    await this.persistStorageState(session);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
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

  async handle<TContext extends DefaultAgentSessionContext>(
    action: BrowserAction,
    run: RunContext<TContext>,
    previewOriginGrant?: BrowserPreviewOriginGrant,
  ): Promise<ToolResultPayload> {
    await this.ensureStarted();

    const scope = normalizeScopeKey(resolveSessionContext(run.context));
    const timeoutMs = this.resolveActionTimeout(action);
    return await this.runWithActionTimeout(
      action,
      scope.key,
      timeoutMs,
      (scopeVersion) => this.handleAction(action, run, scope, timeoutMs, scopeVersion, previewOriginGrant),
    );
  }

  private async handleAction<TContext extends DefaultAgentSessionContext>(
    action: BrowserAction,
    run: RunContext<TContext>,
    scope: {scope: BrowserSessionScope; key: string},
    timeoutMs: number,
    scopeVersion: number,
    previewOriginGrant?: BrowserPreviewOriginGrant,
  ): Promise<ToolResultPayload> {
    const snapshotMode = "snapshotMode" in action ? action.snapshotMode ?? "compact" : "compact";
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
      await this.ensureSafeBrowserTarget(new URL(action.url), previewOriginGrant);
    }

    let session: BrowserSessionRecord | null = null;
    try {
      if (!this.sessions.has(scopeKey)) {
        this.emitProgress(run, "starting", {scope: scope.scope, scopeKey});
      }
      this.emitProgress(run, "connecting", {scope: scope.scope, scopeKey});
      session = await this.resolveSession(scope, run, timeoutMs, scopeVersion);
      if (action.action === "navigate") {
        session.previewOriginGrant = previewOriginGrant;
      }
      const page = await this.ensureActivePage(session);

      switch (action.action) {
        case "navigate": {
          const baseline = await this.captureActionBaseline(session, timeoutMs);
          await baseline.page.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          const settledPage = await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(session, settledPage);
          this.emitProgress(run, "snapshotting", {action: "navigate"});
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
          return await this.buildSnapshotPayload(session, "navigate", snapshotMode, changes, capture);
        }
        case "snapshot":
          this.emitProgress(run, "snapshotting", {action: "snapshot"});
          return await this.buildSnapshotPayload(session, "snapshot", snapshotMode, undefined, undefined, timeoutMs);
        case "click": {
          const baseline = await this.captureActionBaseline(session, timeoutMs);
          const target = formatActionTarget(action);
          this.emitProgress(run, "acting", {
            action: "click",
            ...(target ? {target} : {}),
          });
          const locator = await this.targetLocator(page, action, timeoutMs);
          await locator.click({
            timeout: timeoutMs,
          });
          const settledPage = await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(session, settledPage);
          this.emitProgress(run, "snapshotting", {action: "click"});
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
          return await this.buildSnapshotPayload(session, "click", snapshotMode, changes, capture);
        }
        case "type": {
          const baseline = await this.captureActionBaseline(session, timeoutMs);
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
          const settledPage = await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(session, settledPage);
          this.emitProgress(run, "snapshotting", {action: "type"});
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
          return await this.buildSnapshotPayload(session, "type", snapshotMode, changes, capture);
        }
        case "press": {
          const baseline = await this.captureActionBaseline(session, timeoutMs);
          this.emitProgress(run, "acting", {action: "press", key: action.key});
          if (trimToUndefined(action.ref) || trimToUndefined(action.selector)) {
            await (await this.targetLocator(page, action, timeoutMs)).press(action.key, {
              timeout: timeoutMs,
            });
          } else {
            await withTimeout(page.keyboard.press(action.key), timeoutMs, "browser key press");
          }
          const settledPage = await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(session, settledPage);
          this.emitProgress(run, "snapshotting", {action: "press"});
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
          return await this.buildSnapshotPayload(session, "press", snapshotMode, changes, capture);
        }
        case "select": {
          const baseline = await this.captureActionBaseline(session, timeoutMs);
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
          const settledPage = await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(session, settledPage);
          this.emitProgress(run, "snapshotting", {action: "select"});
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
          return await this.buildSnapshotPayload(session, "select", snapshotMode, changes, capture);
        }
        case "wait": {
          const baseline = await this.captureActionBaseline(session, timeoutMs);
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
          const settledPage = await this.settlePage(session, timeoutMs);
          await this.ensureSafeFinalUrl(session, settledPage);
          this.emitProgress(run, "snapshotting", {action: "wait"});
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
          return await this.buildSnapshotPayload(session, "wait", snapshotMode, changes, capture);
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
        if (persistent) {
          await this.persistStorageState(session).catch(() => undefined);
        }
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
