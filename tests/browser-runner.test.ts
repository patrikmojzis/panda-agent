import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext} from "../src/index.js";
import {BrowserRunnerClient} from "../src/integrations/browser/client.js";
import {type BrowserRunner, startBrowserRunner} from "../src/integrations/browser/runner.js";

type StartBrowserRunnerOptions = NonNullable<Parameters<typeof startBrowserRunner>[0]>;
type LaunchBrowserImpl = NonNullable<StartBrowserRunnerOptions["launchBrowserImpl"]>;

function createAgent() {
  return new Agent({
    name: "browser-runner-test-agent",
    instructions: "Use tools.",
  });
}

function createRunContext(
  context: DefaultAgentSessionContext,
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

type FakeRuntimeDevice = {
  viewport: {width: number; height: number};
  deviceScaleFactor: number;
  userAgent: string;
  maxTouchPoints: number;
  hasTouch: boolean;
};

const FAKE_DESKTOP_RUNTIME_DEVICE: FakeRuntimeDevice = {
  viewport: {width: 1280, height: 720},
  deviceScaleFactor: 1,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120 Safari/537.36",
  maxTouchPoints: 0,
  hasTouch: false,
};

function cloneFakeViewport(value: unknown): {width: number; height: number} | undefined {
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

function fakeRuntimeDeviceFromContextOptions(options: unknown): FakeRuntimeDevice {
  const raw = typeof options === "object" && options !== null
    ? options as Record<string, unknown>
    : {};
  const viewport = cloneFakeViewport(raw.viewport) ?? FAKE_DESKTOP_RUNTIME_DEVICE.viewport;
  const hasTouch = raw.hasTouch === true;
  return {
    viewport,
    deviceScaleFactor: typeof raw.deviceScaleFactor === "number" ? raw.deviceScaleFactor : 1,
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : FAKE_DESKTOP_RUNTIME_DEVICE.userAgent,
    maxTouchPoints: hasTouch ? 5 : 0,
    hasTouch,
  };
}

class FakePage {
  currentUrl = "https://example.com/";
  currentTitle = "Example";
  closed = false;
  runtimeDevice: FakeRuntimeDevice = {...FAKE_DESKTOP_RUNTIME_DEVICE};

  readonly keyboard = {
    press: async () => undefined,
    insertText: async () => undefined,
  };

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async waitForLoadState(): Promise<void> {}

  async waitForTimeout(): Promise<void> {}

  async waitForFunction(): Promise<void> {}

  async setContent(): Promise<void> {}

  async evaluate(pageFunction: unknown, arg?: unknown): Promise<unknown> {
    if (typeof pageFunction === "function") {
      const source = String(pageFunction);
      if (source.includes("maxTouchPoints") && source.includes("devicePixelRatio")) {
        return this.runtimeDevice;
      }
    }
    if (
      arg
      && typeof arg === "object"
      && "script" in arg
      && "maxChars" in arg
    ) {
      return {
        url: this.currentUrl,
        title: this.currentTitle,
        text: "Example body",
        pageText: "Example body",
        dialogText: "",
        signals: [],
        elements: [],
      };
    }

    return undefined;
  }

  locator(): {
    first(): {
      waitFor(): Promise<void>;
      screenshot(): Promise<Buffer>;
    };
  } {
    return {
      first: () => ({
        waitFor: async () => undefined,
        screenshot: async () => Buffer.from("fake-image"),
      }),
    };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("fake-image");
  }

  async pdf(): Promise<Buffer> {
    return Buffer.from("%PDF-test");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class FakeBrowserContext {
  private readonly pagesList: FakePage[] = [];
  newContextOptions: unknown = undefined;

  constructor(private readonly initialPage: FakePage) {}

  async newPage(): Promise<FakePage> {
    const page = this.pagesList.length === 0 ? this.initialPage : new FakePage();
    page.runtimeDevice = fakeRuntimeDeviceFromContextOptions(this.newContextOptions);
    this.pagesList.push(page);
    return page;
  }

  pages(): FakePage[] {
    return this.pagesList;
  }

  async route(): Promise<void> {}

  async close(): Promise<void> {}

  async storageState(): Promise<Record<string, unknown>> {
    return {
      cookies: [],
      origins: [],
    };
  }

  on(_event: "page", _listener: (page: FakePage) => void): void {}
}

class FakeBrowser {
  constructor(private readonly context: FakeBrowserContext) {}

  async newContext(options?: unknown): Promise<FakeBrowserContext> {
    this.context.newContextOptions = options;
    return this.context;
  }

  async close(): Promise<void> {}

  on(_event: "disconnected", _listener: () => void): void {}
}

function asLaunchedBrowser(browser: FakeBrowser): Awaited<ReturnType<LaunchBrowserImpl>> {
  return browser as Awaited<ReturnType<LaunchBrowserImpl>>;
}

function createFakeLaunchBrowser(context: FakeBrowserContext) {
  return vi.fn(async () => asLaunchedBrowser(new FakeBrowser(context)));
}

describe("browser runner transport", () => {
  const tempDirs: string[] = [];
  const runners: BrowserRunner[] = [];

  afterEach(async () => {
    while (runners.length > 0) {
      await runners.pop()?.close();
    }

    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", {recursive: true, force: true});
    }

    vi.restoreAllMocks();
  });

  it("sends agent/session/thread context and auth headers from the core client", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        ok: true,
        text: "Snapshot ok",
        details: {action: "snapshot", title: "Example"},
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const client = new BrowserRunnerClient({
      fetchImpl: fetchImpl as typeof fetch,
      runnerUrl: "http://runner.internal/base",
      sharedSecret: "secret-123",
    });

    const result = await client.handle(
      {action: "snapshot", deviceProfile: "mobile"},
      createRunContext({
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
        cwd: "/workspace/panda",
      }),
    );

    expect(result.details).toMatchObject({action: "snapshot", title: "Example"});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://runner.internal/base/action");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer secret-123",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      action: {action: "snapshot", deviceProfile: "mobile"},
    });
  });

  it("applies runner device profiles and reports them in logs and details", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-runner-"));
    tempDirs.push(tempDir);
    const context = new FakeBrowserContext(new FakePage());
    const launchBrowserImpl = createFakeLaunchBrowser(context);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = await startBrowserRunner({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret-123",
      launchBrowserImpl,
      dataDir: tempDir,
    });
    runners.push(runner);

    const response = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-123",
      },
      body: JSON.stringify({
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
        action: {action: "snapshot", deviceProfile: "mobile"},
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      details: {
        action: "snapshot",
        scope: "session",
        deviceProfile: "mobile",
        device: {
          profile: "mobile",
          viewport: {width: 412, height: 839},
          deviceScaleFactor: 2.625,
          isMobile: true,
          hasTouch: true,
        },
        runtimeDevice: {
          profile: "mobile",
          viewport: {width: 412, height: 839},
          deviceScaleFactor: 2.625,
          userAgent: expect.stringContaining("Mobile"),
          maxTouchPoints: 5,
          hasTouch: true,
        },
      },
    });
    expect(context.newContextOptions).toMatchObject({
      viewport: {width: 412, height: 839},
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    });
    expect(log.mock.calls.some(([line]) => String(line).includes('"deviceProfile":"mobile"'))).toBe(true);
    expect(log.mock.calls.some(([line]) => String(line).includes('"device":{"profile":"mobile"'))).toBe(true);
    expect(log.mock.calls.some(([line]) => String(line).includes('"runtimeDevice":{"profile":"mobile"'))).toBe(true);
  });

  it("rewrites disposable worker loopback preview URLs to the worker container origin", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        ok: true,
        text: "Snapshot ok",
        details: {action: "navigate"},
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const client = new BrowserRunnerClient({
      fetchImpl: fetchImpl as typeof fetch,
      runnerUrl: "http://runner.internal",
      sharedSecret: "secret-123",
    });

    await client.handle(
      {action: "navigate", url: "http://localhost:5173/path?q=1#top"},
      createRunContext({
        agentKey: "panda",
        sessionId: "worker-session-1",
        threadId: "worker-thread-1",
        cwd: "/workspace",
        executionEnvironment: {
          id: "env-1",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "remote",
          metadata: {
            containerName: "panda-env-worker-abc",
            network: "panda_disposable_runner_net",
          },
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "allowlist", skillKeys: []},
          toolPolicy: {},
          source: "binding",
        },
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: {action: "navigate", url: "http://panda-env-worker-abc:5173/path?q=1#top"},
      previewOriginGrant: {
        originalOrigin: "http://localhost:5173",
        resolvedOrigin: "http://panda-env-worker-abc:5173",
      },
    });
  });

  it("rewrites 127.0.0.1 and [::1] previews only for disposable worker environments", async () => {
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        ok: true,
        text: "Snapshot ok",
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const client = new BrowserRunnerClient({
      fetchImpl: fetchImpl as typeof fetch,
      runnerUrl: "http://runner.internal",
      sharedSecret: "secret-123",
    });
    const workerContext = createRunContext({
      agentKey: "panda",
      sessionId: "worker-session-1",
      threadId: "worker-thread-1",
      cwd: "/workspace",
      executionEnvironment: {
        id: "env-1",
        agentKey: "panda",
        kind: "disposable_container",
        state: "ready",
        executionMode: "remote",
        metadata: {
          containerName: "panda-env-worker-abc",
          network: "panda_disposable_runner_net",
        },
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "allowlist", skillKeys: []},
        toolPolicy: {},
        source: "binding",
      },
    });

    await client.handle({action: "navigate", url: "http://127.0.0.1:5173/"}, workerContext);
    await client.handle({action: "navigate", url: "http://[::1]:5174/"}, workerContext);
    await client.handle(
      {action: "navigate", url: "http://localhost:5175/"},
      createRunContext({
        agentKey: "panda",
        sessionId: "main-session-1",
        threadId: "thread-1",
        cwd: "/workspace",
      }),
    );

    expect(requests).toMatchObject([
      {
        action: {url: "http://panda-env-worker-abc:5173/"},
        previewOriginGrant: {
          originalOrigin: "http://127.0.0.1:5173",
          resolvedOrigin: "http://panda-env-worker-abc:5173",
        },
      },
      {
        action: {url: "http://panda-env-worker-abc:5174/"},
        previewOriginGrant: {
          originalOrigin: "http://[::1]:5174",
          resolvedOrigin: "http://panda-env-worker-abc:5174",
        },
      },
      {
        action: {url: "http://localhost:5175/"},
      },
    ]);
    expect((requests[2] as {previewOriginGrant?: unknown}).previewOriginGrant).toBeUndefined();
  });

  it("fails worker preview rewrites when disposable environment Docker metadata is missing", async () => {
    const fetchImpl = vi.fn();
    const client = new BrowserRunnerClient({
      fetchImpl: fetchImpl as typeof fetch,
      runnerUrl: "http://runner.internal",
      sharedSecret: "secret-123",
    });

    await expect(client.handle(
      {action: "navigate", url: "http://localhost:5173/"},
      createRunContext({
        agentKey: "panda",
        sessionId: "worker-session-1",
        threadId: "worker-thread-1",
        cwd: "/workspace",
        executionEnvironment: {
          id: "env-1",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "remote",
          metadata: {containerName: "panda-env-worker-abc"},
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "allowlist", skillKeys: []},
          toolPolicy: {},
          source: "binding",
        },
      }),
    )).rejects.toThrow("Worker browser preview is unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("copies screenshot artifacts into Panda media paths and rewrites the returned metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-client-"));
    tempDirs.push(tempDir);
    const imageBase64 = Buffer.from("fake-image").toString("base64");
    const client = new BrowserRunnerClient({
      runnerUrl: "http://runner.internal",
      sharedSecret: "secret-123",
      dataDir: tempDir,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        text: "Browser screenshot saved to /runner/shot.png",
        details: {
          action: "screenshot",
          path: "/runner/shot.png",
          artifact: {
            kind: "image",
            source: "browser",
            path: "/runner/shot.png",
            mimeType: "image/png",
            bytes: 10,
          },
        },
        artifact: {
          kind: "image",
          mimeType: "image/png",
          data: imageBase64,
          bytes: 10,
          path: "/runner/shot.png",
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      })) as typeof fetch,
    });

    const result = await client.handle(
      {action: "screenshot", fullPage: true},
      createRunContext({
        agentKey: "panda",
        threadId: "thread-1",
        cwd: "/workspace/panda",
      }),
    );

    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: imageBase64,
    });
    const screenshotPath = String((result.details as Record<string, unknown>).path);
    const artifact = (result.details as {artifact: Record<string, unknown>}).artifact;
    expect(screenshotPath).toContain(path.join("agents", "panda", "media", "browser", "thread-1"));
    expect(artifact.storagePath).toBeUndefined();
    expect((result.content[0] as {type: string; text: string}).text).toContain(screenshotPath);
    await expect(readFile(screenshotPath, "utf8")).resolves.toContain("fake-image");
  });

  it("copies bound worker screenshot and PDF artifacts into shared artifact paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-client-worker-"));
    tempDirs.push(tempDir);
    const imageBase64 = Buffer.from("fake-image").toString("base64");
    const pdfBase64 = Buffer.from("%PDF-test").toString("base64");
    const environmentRoot = path.join(tempDir, "worker-env");
    const artifactsCorePath = path.join(environmentRoot, "artifacts");
    const responses: unknown[] = [
      {
        ok: true,
        text: "Browser screenshot saved to /runner/shot.png",
        details: {
          action: "screenshot",
          path: "/runner/shot.png",
          artifact: {
            kind: "image",
            source: "browser",
            path: "/runner/shot.png",
            mimeType: "image/png",
            bytes: 10,
          },
        },
        artifact: {
          kind: "image",
          mimeType: "image/png",
          data: imageBase64,
          bytes: 10,
          path: "/runner/shot.png",
        },
      },
      {
        ok: true,
        text: "Browser PDF saved to /runner/report.pdf",
        details: {
          action: "pdf",
          path: "/runner/report.pdf",
          artifact: {
            kind: "pdf",
            source: "browser",
            path: "/runner/report.pdf",
            mimeType: "application/pdf",
            bytes: 9,
          },
        },
        artifact: {
          kind: "pdf",
          mimeType: "application/pdf",
          data: pdfBase64,
          bytes: 9,
          path: "/runner/report.pdf",
        },
      },
    ];
    const client = new BrowserRunnerClient({
      runnerUrl: "http://runner.internal",
      sharedSecret: "secret-123",
      dataDir: tempDir,
      fetchImpl: vi.fn(async () => {
        const payload = responses.shift();
        if (!payload) {
          throw new Error("Unexpected browser runner request.");
        }

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {"content-type": "application/json"},
        });
      }) as typeof fetch,
    });

    const workerContext: DefaultAgentSessionContext = {
      agentKey: "panda",
      sessionId: "worker-session-1",
      threadId: "worker-thread-1",
      cwd: "/workspace",
      executionEnvironment: {
        id: "env-1",
        agentKey: "panda",
        kind: "disposable_container",
        state: "ready",
        executionMode: "remote",
        metadata: {
          filesystem: {
            envDir: "worker-a",
            root: {
              corePath: environmentRoot,
              parentRunnerPath: "/environments/worker-a",
            },
            workspace: {
              corePath: path.join(environmentRoot, "workspace"),
              workerPath: "/workspace",
              parentRunnerPath: "/environments/worker-a/workspace",
            },
            inbox: {
              corePath: path.join(environmentRoot, "inbox"),
              workerPath: "/inbox",
              parentRunnerPath: "/environments/worker-a/inbox",
            },
            artifacts: {
              corePath: artifactsCorePath,
              workerPath: "/artifacts",
              parentRunnerPath: "/environments/worker-a/artifacts",
            },
          },
        },
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "allowlist", skillKeys: []},
        toolPolicy: {},
        source: "binding",
      },
    };

    const screenshot = await client.handle(
      {action: "screenshot", fullPage: true},
      createRunContext(workerContext),
    );
    const pdf = await client.handle(
      {action: "pdf"},
      createRunContext(workerContext),
    );

    const screenshotDetails = screenshot.details as Record<string, unknown> & {artifact: Record<string, unknown>};
    const screenshotPath = String(screenshotDetails.path);
    const screenshotStoragePath = String(screenshotDetails.artifact.storagePath);
    expect(screenshotPath).toMatch(/^\/artifacts\/media\/browser\/worker-thread-1\/.+\.png$/);
    expect(screenshotDetails.artifact.path).toBe(screenshotPath);
    expect(screenshotStoragePath).toContain(path.join(artifactsCorePath, "media", "browser", "worker-thread-1"));
    expect(screenshotStoragePath).not.toBe(screenshotPath);
    expect(Object.prototype.hasOwnProperty.call(screenshotDetails, "storagePath")).toBe(false);
    expect((screenshot.content[0] as {type: string; text: string}).text).toContain(screenshotPath);
    expect((screenshot.content[0] as {type: string; text: string}).text).not.toContain(artifactsCorePath);
    expect((screenshot.content[0] as {type: string; text: string}).text).not.toContain("storagePath");
    await expect(readFile(screenshotStoragePath, "utf8")).resolves.toContain("fake-image");

    const pdfDetails = pdf.details as Record<string, unknown> & {artifact: Record<string, unknown>};
    const pdfPath = String(pdfDetails.path);
    const pdfStoragePath = String(pdfDetails.artifact.storagePath);
    expect(pdfPath).toMatch(/^\/artifacts\/media\/browser\/worker-thread-1\/.+\.pdf$/);
    expect(pdfDetails.artifact.path).toBe(pdfPath);
    expect(pdfStoragePath).toContain(path.join(artifactsCorePath, "media", "browser", "worker-thread-1"));
    expect(pdfStoragePath).not.toBe(pdfPath);
    expect(Object.prototype.hasOwnProperty.call(pdfDetails, "storagePath")).toBe(false);
    expect((pdf.content[0] as {type: string; text: string}).text).toContain(pdfPath);
    expect((pdf.content[0] as {type: string; text: string}).text).not.toContain(artifactsCorePath);
    expect((pdf.content[0] as {type: string; text: string}).text).not.toContain("storagePath");
    await expect(readFile(pdfStoragePath, "utf8")).resolves.toContain("%PDF-test");
  });

  it("rejects missing and wrong bearer tokens at the runner boundary", async () => {
    const launchBrowserImpl = createFakeLaunchBrowser(new FakeBrowserContext(new FakePage()));
    const runner = await startBrowserRunner({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret-123",
      launchBrowserImpl,
    });
    runners.push(runner);

    const missing = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        agentKey: "panda",
        threadId: "thread-1",
        action: {action: "snapshot"},
      }),
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer nope",
      },
      body: JSON.stringify({
        agentKey: "panda",
        threadId: "thread-1",
        action: {action: "snapshot"},
      }),
    });
    expect(wrong.status).toBe(403);
    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });

  it("returns validation details as protocol JSON for malformed action requests", async () => {
    const launchBrowserImpl = createFakeLaunchBrowser(new FakeBrowserContext(new FakePage()));
    const runner = await startBrowserRunner({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret-123",
      launchBrowserImpl,
    });
    runners.push(runner);

    const response = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-123",
      },
      body: JSON.stringify({
        agentKey: "panda",
        threadId: "thread-1",
        action: {action: "not-real"},
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      details: {
        issues: expect.arrayContaining([expect.any(String)]),
      },
    });
    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });

  it("rejects forged preview origin grants at the runner boundary", async () => {
    const launchBrowserImpl = createFakeLaunchBrowser(new FakeBrowserContext(new FakePage()));
    const runner = await startBrowserRunner({
      host: "127.0.0.1",
      port: 0,
      sharedSecret: "secret-123",
      launchBrowserImpl,
    });
    runners.push(runner);

    const snapshotGrant = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-123",
      },
      body: JSON.stringify({
        agentKey: "panda",
        threadId: "thread-1",
        action: {action: "snapshot"},
        previewOriginGrant: {
          originalOrigin: "http://localhost:5173",
          resolvedOrigin: "http://panda-env-worker-abc:5173",
        },
      }),
    });
    expect(snapshotGrant.status).toBe(400);
    await expect(snapshotGrant.json()).resolves.toMatchObject({
      ok: false,
      error: "Browser preview origin grants are only allowed for navigate actions.",
    });

    const internalServiceGrant = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-123",
      },
      body: JSON.stringify({
        agentKey: "panda",
        threadId: "thread-1",
        action: {action: "navigate", url: "http://panda-core:8080/"},
        previewOriginGrant: {
          originalOrigin: "http://localhost:5173",
          resolvedOrigin: "http://panda-core:8080",
        },
      }),
    });
    expect(internalServiceGrant.status).toBe(400);
    await expect(internalServiceGrant.json()).resolves.toMatchObject({
      ok: false,
      error: "Browser preview origin grant resolved host is not a managed disposable container.",
    });

    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });
});
