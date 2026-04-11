import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, type PandaSessionContext, RunContext, ToolError,} from "../src/index.js";
import {BrowserTool} from "../src/personas/panda/tools/browser-tool.js";
import {BrowserSessionService, buildBrowserDockerRunArgs} from "../src/personas/panda/tools/browser-service.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: PandaSessionContext,
  options: {
    signal?: AbortSignal;
    onToolProgress?: (progress: Record<string, unknown>) => void;
  } = {},
): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
    signal: options.signal,
    onToolProgress: options.onToolProgress as any,
  });
}

type SnapshotResult = {
  url: string;
  title: string;
  text: string;
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type?: string;
    disabled?: boolean;
  }>;
};

class FakeLocator {
  constructor(private readonly page: FakePage, private readonly selector: string) {}

  first(): FakeLocator {
    return this;
  }

  async waitFor(): Promise<void> {}

  async click(): Promise<void> {
    this.page.clickedSelectors.push(this.selector);
    await this.page.onLocatorClick?.(this.selector);
  }

  async fill(value: string): Promise<void> {
    this.page.filledValues.push({selector: this.selector, value});
  }

  async press(key: string): Promise<void> {
    this.page.pressedKeys.push({selector: this.selector, key});
  }

  async selectOption(values: unknown): Promise<string[]> {
    this.page.selectedValues.push({selector: this.selector, values});
    return [];
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(`locator-shot:${this.selector}`);
  }
}

class FakePage {
  currentUrl = "https://example.com/";
  currentTitle = "Example";
  snapshot: SnapshotResult = {
    url: "https://example.com/",
    title: "Example",
    text: "Readable body text",
    elements: [{ref: "e1", tag: "a", role: "link", text: "Docs"}],
  };
  nextGotoUrl: string | null = null;
  closed = false;
  clickedSelectors: string[] = [];
  filledValues: Array<{selector: string; value: string}> = [];
  pressedKeys: Array<{selector: string; key: string}> = [];
  selectedValues: Array<{selector: string; values: unknown}> = [];
  locatorSelectors: string[] = [];
  keyboardPressed: string[] = [];
  keyboardInsertedText: string[] = [];
  onLocatorClick?: (selector: string) => Promise<void> | void;

  readonly keyboard = {
    press: async (key: string) => {
      this.keyboardPressed.push(key);
    },
    insertText: async (text: string) => {
      this.keyboardInsertedText.push(text);
    },
  };

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = this.nextGotoUrl ?? url;
  }

  async waitForLoadState(): Promise<void> {}

  async waitForTimeout(): Promise<void> {}

  async waitForFunction(): Promise<void> {}

  async evaluate(pageFunction: unknown, arg?: unknown): Promise<unknown> {
    if (
      arg
      && typeof arg === "object"
      && "script" in arg
      && "maxChars" in arg
    ) {
      return this.snapshot;
    }
    if (typeof pageFunction === "function") {
      return await (pageFunction as (value: unknown) => unknown)(arg);
    }
    throw new Error("Unexpected evaluate call in test.");
  }

  locator(selector: string): FakeLocator {
    this.locatorSelectors.push(selector);
    return new FakeLocator(this, selector);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("page-shot");
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
  private readonly pageQueue: FakePage[];
  private readonly pagesList: FakePage[] = [];
  routeHandler: ((route: {
    request(): {url(): string};
    abort(reason?: string): Promise<void>;
    continue(): Promise<void>;
  }) => Promise<void>) | null = null;
  private pageListener: ((page: FakePage) => void) | null = null;

  constructor(initialPage: FakePage) {
    this.pageQueue = [initialPage];
  }

  async newPage(): Promise<FakePage> {
    const page = this.pageQueue.shift() ?? new FakePage();
    this.pagesList.push(page);
    return page;
  }

  pages(): FakePage[] {
    return this.pagesList;
  }

  async route(
    _pattern: string | RegExp,
    handler: (route: {
      request(): {url(): string};
      abort(reason?: string): Promise<void>;
      continue(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    this.routeHandler = handler;
  }

  async close(): Promise<void> {}

  on(event: "page", listener: (page: FakePage) => void): void {
    if (event === "page") {
      this.pageListener = listener;
    }
  }

  emitPage(page: FakePage): void {
    this.pagesList.push(page);
    this.pageListener?.(page);
  }
}

class FakeBrowser {
  private disconnectListener: (() => void) | null = null;

  constructor(readonly context: FakeBrowserContext) {}

  async newContext(): Promise<FakeBrowserContext> {
    return this.context;
  }

  async close(): Promise<void> {
    this.disconnectListener?.();
  }

  on(event: "disconnected", listener: () => void): void {
    if (event === "disconnected") {
      this.disconnectListener = listener;
    }
  }
}

function createDockerExecMock() {
  let nextContainerId = 1;
  const inspectRecords = new Map<string, unknown>();
  const removedIds: string[] = [];
  const execFileImpl = vi.fn(async (_file: string, args: readonly string[]) => {
    const [command, ...rest] = args;
    if (command === "ps") {
      return {stdout: "", stderr: ""};
    }
    if (command === "run") {
      const containerId = `container-${nextContainerId++}`;
      inspectRecords.set(containerId, {
        Id: containerId,
        Config: {
          Labels: {
            "panda.browser": "1",
            "panda.startedAtMs": String(Date.now()),
          },
        },
        State: {
          Running: true,
        },
        NetworkSettings: {
          Ports: {
            "3000/tcp": [{HostIp: "127.0.0.1", HostPort: "45678"}],
          },
        },
      });
      return {stdout: `${containerId}\n`, stderr: ""};
    }
    if (command === "inspect") {
      const ids = rest;
      return {
        stdout: JSON.stringify(ids.map((id) => inspectRecords.get(id) ?? {
          Id: id,
          Config: {
            Labels: {
              "panda.browser": "1",
              "panda.startedAtMs": String(Date.now()),
            },
          },
          State: {
            Running: true,
          },
          NetworkSettings: {
            Ports: {
              "3000/tcp": [{HostIp: "127.0.0.1", HostPort: "45678"}],
            },
          },
        })),
        stderr: "",
      };
    }
    if (command === "rm") {
      removedIds.push(...rest.slice(1));
      return {stdout: rest.slice(1).join("\n"), stderr: ""};
    }
    throw new Error(`Unexpected docker command: ${args.join(" ")}`);
  });

  return {
    execFileImpl,
    removedIds,
  };
}

describe("BrowserTool", () => {
  const tempDirs: string[] = [];
  const services: BrowserSessionService[] = [];

  afterEach(async () => {
    for (const service of services) {
      await service.close().catch(() => undefined);
    }
    services.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, {recursive: true, force: true})));
    tempDirs.length = 0;
    vi.restoreAllMocks();
  });

  it("validates the action schema", () => {
    expect(() => BrowserTool.schema.parse({
      action: "navigate",
      url: "https://example.com",
    })).not.toThrow();

    expect(() => BrowserTool.schema.parse({
      action: "click",
    })).toThrow("ref or selector is required.");

    expect(() => BrowserTool.schema.parse({
      action: "wait",
      selector: ".result",
      text: "ready",
    })).toThrow("wait requires exactly one of loadState, selector, text, or url.");

    expect(() => BrowserTool.schema.parse({
      action: "select",
      selector: "select",
    })).toThrow("value or values is required.");
  });

  it("delegates to the injected service and formats calls cleanly", async () => {
    const handle = vi.fn(async () => ({
      content: [{type: "text" as const, text: "# Example"}],
      details: {action: "navigate", title: "Example"},
    }));
    const tool = new BrowserTool({
      service: {handle},
    });

    expect(tool.formatCall({action: "navigate", url: "https://example.com"})).toBe("navigate https://example.com");
    const result = await tool.run(
      {action: "navigate", url: "https://example.com"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(handle).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({action: "navigate", title: "Example"});
  });

  it("builds the Docker command with pwuser, seccomp, labels, and loopback port mapping", () => {
    const args = buildBrowserDockerRunArgs({
      image: "mcr.microsoft.com/playwright:v1.59.1-noble",
      scopeKey: "thread-123",
      startedAtMs: 123456789,
    });

    expect(args).toContain("--init");
    expect(args).toContain("--ipc=host");
    expect(args).toContain("pwuser");
    expect(args).toContain("127.0.0.1::3000");
    expect(args).toContain("panda.browser=1");
    expect(args).toContain("panda.threadId=thread-123");
    expect(args.some((value) => value.includes("seccomp=") && value.endsWith("assets/playwright-seccomp-profile.json"))).toBe(true);
  });

  it("reuses sessions per thread and isolates them across threads", async () => {
    const docker = createDockerExecMock();
    const browserOne = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const browserTwo = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const connectBrowserImpl = vi.fn()
      .mockResolvedValueOnce(browserOne as any)
      .mockResolvedValueOnce(browserTwo as any);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: connectBrowserImpl as any,
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle({action: "snapshot"}, createRunContext({cwd: "/workspace/panda", threadId: "thread-a"}));
    await service.handle({action: "snapshot"}, createRunContext({cwd: "/workspace/panda", threadId: "thread-a"}));
    await service.handle({action: "snapshot"}, createRunContext({cwd: "/workspace/panda", threadId: "thread-b"}));

    expect(connectBrowserImpl).toHaveBeenCalledTimes(2);
    expect(docker.execFileImpl.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(2);
  });

  it("cleans up stale or stopped orphan containers on startup", async () => {
    const execFileImpl = vi.fn(async (_file: string, args: readonly string[]) => {
      const [command, ...rest] = args;
      if (command === "ps") {
        return {stdout: "stale\nrunning\nstopped\n", stderr: ""};
      }
      if (command === "inspect") {
        expect(rest).toEqual(["stale", "running", "stopped"]);
        return {
          stdout: JSON.stringify([
            {
              Id: "stale",
              Config: {Labels: {"panda.startedAtMs": "10"}},
              State: {Running: true},
            },
            {
              Id: "running",
              Config: {Labels: {"panda.startedAtMs": "980"}},
              State: {Running: true},
            },
            {
              Id: "stopped",
              Config: {Labels: {"panda.startedAtMs": "990"}},
              State: {Running: false},
            },
          ]),
          stderr: "",
        };
      }
      if (command === "rm") {
        expect(rest).toEqual(["-f", "stale", "running", "stopped"]);
        return {stdout: "stale\nrunning\nstopped\n", stderr: ""};
      }
      throw new Error(`Unexpected docker command: ${args.join(" ")}`);
    });
    const service = new BrowserSessionService({
      execFileImpl: execFileImpl as any,
      now: () => 1_000,
      sessionMaxAgeMs: 100,
    });
    services.push(service);

    await service.cleanupStartupContainers();

    expect(execFileImpl).toHaveBeenCalledTimes(3);
  });

  it("retries startup after the first lazy-start bootstrap failure", async () => {
    const docker = createDockerExecMock();
    let failStartup = true;
    const execFileImpl = vi.fn(async (file: string, args: readonly string[], options?: {
      encoding?: BufferEncoding;
      signal?: AbortSignal;
    }) => {
      if (args[0] === "ps" && failStartup) {
        failStartup = false;
        const error = new Error("docker unavailable") as Error & {stderr?: string};
        error.stderr = "daemon down";
        throw error;
      }
      return await docker.execFileImpl(file, args, options as never);
    });
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(new FakePage())) as any),
      dataDir: tempDir,
    });
    services.push(service);

    await expect(service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    )).rejects.toThrow(/browser docker command failed/i);

    const result = await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(result.details).toMatchObject({action: "snapshot"});
    expect(execFileImpl.mock.calls.filter(([, args]) => args[0] === "ps")).toHaveLength(2);
  });

  it("cleans up the container when session startup fails after docker run", async () => {
    const docker = createDockerExecMock();
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => ({
        newContext: async () => {
          throw new Error("context failed");
        },
        close: async () => {},
        on: () => {},
      }) as any),
    });
    services.push(service);

    await expect(service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    )).rejects.toThrow("context failed");

    expect(docker.removedIds).toContain("container-1");
  });

  it("blocks private targets before navigation starts", async () => {
    const docker = createDockerExecMock();
    const connectBrowserImpl = vi.fn();
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: connectBrowserImpl as any,
      lookupHostname: async () => ["127.0.0.1"],
    });
    services.push(service);

    await expect(service.handle(
      {action: "navigate", url: "https://internal.example"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    )).rejects.toBeInstanceOf(ToolError);

    expect(connectBrowserImpl).not.toHaveBeenCalled();
    expect(docker.execFileImpl.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
  });

  it("blocks redirects that land on a private final URL", async () => {
    const docker = createDockerExecMock();
    const page = new FakePage();
    page.nextGotoUrl = "http://169.254.169.254/latest/meta-data";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
      lookupHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["169.254.169.254"],
      dataDir: tempDir,
    });
    services.push(service);

    await expect(service.handle(
      {action: "navigate", url: "https://example.com"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    )).rejects.toThrow(/browser blocked/i);
  });

  it("guards routed subresource requests and aborts blocked ones", async () => {
    const docker = createDockerExecMock();
    const context = new FakeBrowserContext(new FakePage());
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      lookupHostname: async () => ["93.184.216.34"],
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    const routeEvents: string[] = [];
    await context.routeHandler?.({
      request: () => ({url: () => "http://127.0.0.1/private"}),
      abort: async () => {
        routeEvents.push("abort");
      },
      continue: async () => {
        routeEvents.push("continue");
      },
    });

    expect(routeEvents).toEqual(["abort"]);
  });

  it("re-checks routed requests instead of caching allow decisions forever", async () => {
    const docker = createDockerExecMock();
    const context = new FakeBrowserContext(new FakePage());
    const lookupHostname = vi.fn(async () => ["93.184.216.34"]);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      lookupHostname,
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    for (let index = 0; index < 2; index += 1) {
      await context.routeHandler?.({
        request: () => ({url: () => "https://cdn.example.com/app.js"}),
        abort: async () => undefined,
        continue: async () => undefined,
      });
    }

    expect(lookupHostname).toHaveBeenCalledTimes(2);
    expect(lookupHostname).toHaveBeenNthCalledWith(1, "cdn.example.com");
    expect(lookupHostname).toHaveBeenNthCalledWith(2, "cdn.example.com");
  });

  it("enforces idle TTL on reuse instead of waiting for the background reaper", async () => {
    const docker = createDockerExecMock();
    const browserOne = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const browserTwo = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const connectBrowserImpl = vi.fn()
      .mockResolvedValueOnce(browserOne as any)
      .mockResolvedValueOnce(browserTwo as any);
    let now = 0;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: connectBrowserImpl as any,
      dataDir: tempDir,
      now: () => now,
      sessionIdleTtlMs: 100,
      sessionMaxAgeMs: 10_000,
      reaperIntervalMs: 60_000,
    });
    services.push(service);

    await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );
    now = 150;
    await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(connectBrowserImpl).toHaveBeenCalledTimes(2);
    expect(docker.removedIds).toContain("container-1");
  });

  it("returns compact snapshots with stable refs and uses ref selectors for actions", async () => {
    const docker = createDockerExecMock();
    const page = new FakePage();
    page.snapshot = {
      url: "https://example.com/docs",
      title: "Docs",
      text: "Hello from the docs page",
      elements: [{ref: "e1", tag: "button", role: "button", text: "Continue"}],
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
      dataDir: tempDir,
    });
    services.push(service);

    const snapshot = await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );
    const click = await service.handle(
      {action: "click", ref: "e1"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(snapshot.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("- [e1] button \"Continue\""),
    });
    expect(page.locatorSelectors).toContain('[data-panda-ref="e1"]');
    expect(click.details).toMatchObject({action: "click"});
  });

  it("switches to the newest popup page automatically", async () => {
    const docker = createDockerExecMock();
    const page = new FakePage();
    const context = new FakeBrowserContext(page);
    const popup = new FakePage();
    popup.currentUrl = "https://example.com/popup";
    popup.currentTitle = "Popup";
    popup.snapshot = {
      url: popup.currentUrl,
      title: popup.currentTitle,
      text: "Popup body",
      elements: [],
    };
    page.onLocatorClick = async () => {
      context.emitPage(popup);
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "click", selector: "a[target=_blank]"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(result.details).toMatchObject({
      url: "https://example.com/popup",
      title: "Popup",
    });
    expect(page.closed).toBe(true);
  });

  it("caps evaluate results and writes screenshot/pdf artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const docker = createDockerExecMock();
    const page = new FakePage();
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
      dataDir: tempDir,
      maxEvaluateResultChars: 12,
    });
    services.push(service);

    const evaluate = await service.handle(
      {action: "evaluate", script: "return 'abcdefghijklmnopqrstuvwxyz';"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );
    const screenshot = await service.handle(
      {action: "screenshot", fullPage: true},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );
    const pdf = await service.handle(
      {action: "pdf"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(evaluate.details).toMatchObject({
      action: "evaluate",
      truncated: true,
    });
    expect((evaluate.content[0] as {type: string; text: string}).text.length).toBeLessThanOrEqual(12);

    expect(screenshot.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    const screenshotPath = String((screenshot.details as Record<string, unknown>).path);
    const pdfPath = String((pdf.details as Record<string, unknown>).path);
    await expect(stat(screenshotPath)).resolves.toBeTruthy();
    await expect(stat(pdfPath)).resolves.toBeTruthy();
    await expect(readFile(pdfPath, "utf8")).resolves.toContain("%PDF-test");
  });

  it("closes the persistent session and removes the container", async () => {
    const docker = createDockerExecMock();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(new FakePage())) as any),
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );
    const result = await service.handle(
      {action: "close"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(result.details).toMatchObject({action: "close", closed: true});
    expect(docker.removedIds).toContain("container-1");
  });
});
