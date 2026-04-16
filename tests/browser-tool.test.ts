import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext, ToolError,} from "../src/index.js";
import {BrowserTool} from "../src/panda/tools/browser-tool.js";
import {BrowserSessionService, buildBrowserDockerRunArgs} from "../src/panda/tools/browser-service.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: DefaultAgentSessionContext,
  options: {
    signal?: AbortSignal;
    onToolProgress?: (progress: Record<string, unknown>) => void;
  } = {},
): RunContext<DefaultAgentSessionContext> {
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
  pageText: string;
  dialogText: string;
  signals: string[];
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type?: string;
    disabled?: boolean;
    value?: string;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
    pressed?: boolean;
    required?: boolean;
    invalid?: boolean;
    readonly?: boolean;
    href?: string;
    section?: "page" | "dialog";
  }>;
};

class FakeLocator {
  constructor(private readonly page: FakePage, private readonly selector: string) {}

  private findSnapshotElement() {
    const match = this.selector.match(/data-runtime-ref="(e\d+)"/);
    if (!match) {
      return undefined;
    }
    return this.page.snapshot.elements.find((element) => element.ref === match[1]);
  }

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
    const element = this.findSnapshotElement();
    if (element) {
      element.value = value;
    }
  }

  async press(key: string): Promise<void> {
    this.page.pressedKeys.push({selector: this.selector, key});
  }

  async selectOption(values: unknown): Promise<string[]> {
    this.page.selectedValues.push({selector: this.selector, values});
    const element = this.findSnapshotElement();
    if (element) {
      element.selected = true;
      const nextValues = Array.isArray(values) ? values : [];
      const firstValue = nextValues[0];
      if (firstValue && typeof firstValue === "object" && "value" in firstValue) {
        element.value = String((firstValue as {value: unknown}).value ?? "");
      }
    }
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
    pageText: "Readable body text",
    dialogText: "",
    signals: [],
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
  labelOverlaysInstalled = 0;
  labelOverlaysRemoved = 0;
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
      const source = String(pageFunction);
      if (source.includes("runtime-browser-ref-overlays")) {
        if (arg && typeof arg === "object" && "refAttribute" in arg) {
          this.labelOverlaysInstalled += 1;
        } else {
          this.labelOverlaysRemoved += 1;
        }
        return undefined;
      }
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
  storageStateInput: unknown = undefined;
  storageStatePaths: string[] = [];

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

  async storageState(options?: {path?: string}): Promise<Record<string, unknown>> {
    if (options?.path) {
      this.storageStatePaths.push(options.path);
      await writeFile(options.path, JSON.stringify({
        cookies: [{name: "session", value: "persisted"}],
        origins: [],
      }), "utf8");
    }
    return {
      cookies: [{name: "session", value: "persisted"}],
      origins: [],
    };
  }

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

  async newContext(options?: {storageState?: unknown}): Promise<FakeBrowserContext> {
    this.context.storageStateInput = options?.storageState;
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
            "runtime.browser": "1",
            "runtime.startedAtMs": String(Date.now()),
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
              "runtime.browser": "1",
              "runtime.startedAtMs": String(Date.now()),
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
      snapshotMode: "full",
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

    expect(() => BrowserTool.schema.parse({
      action: "screenshot",
      ref: "e1",
      labels: true,
    })).toThrow("labels is only supported for whole-page screenshots.");
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

  it("keeps live screenshot previews but redacts inline image data for persistence", () => {
    const tool = new BrowserTool({
      service: {
        handle: vi.fn(),
      },
    });
    const message = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        {type: "text" as const, text: "Browser screenshot saved to /tmp/shot.png"},
        {type: "image" as const, data: "ZmFrZQ==", mimeType: "image/png"},
      ],
      details: {
        action: "screenshot",
        path: "/tmp/shot.png",
        artifact: {
          kind: "image",
          source: "browser",
          path: "/tmp/shot.png",
          mimeType: "image/png",
        },
      },
    };

    const redacted = tool.redactResultMessage(message);

    expect(message.content).toHaveLength(2);
    expect(redacted.content).toEqual([
      {type: "text", text: "Browser screenshot saved to /tmp/shot.png"},
    ]);
    expect(redacted.details).toMatchObject({
      action: "screenshot",
      path: "/tmp/shot.png",
      artifact: {
        kind: "image",
        source: "browser",
        path: "/tmp/shot.png",
        mimeType: "image/png",
      },
    });
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
    expect(args).toContain("runtime.browser=1");
    expect(args).toContain("runtime.threadId=thread-123");
    expect(args.some((value) => value.includes("seccomp=") && value.endsWith("assets/playwright-seccomp-profile.json"))).toBe(true);
  });

  it("reuses sessions per thread and isolates them across threads", async () => {
    const docker = createDockerExecMock();
    const browserOne = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const browserTwo = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const connectBrowserImpl = vi.fn()
      .mockResolvedValueOnce(browserOne as any)
      .mockResolvedValueOnce(browserTwo as any);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
              Config: {Labels: {"runtime.startedAtMs": "10"}},
              State: {Running: true},
            },
            {
              Id: "running",
              Config: {Labels: {"runtime.startedAtMs": "980"}},
              State: {Running: true},
            },
            {
              Id: "stopped",
              Config: {Labels: {"runtime.startedAtMs": "990"}},
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
      pageText: "Hello from the docs page",
      dialogText: "",
      signals: [],
      elements: [{ref: "e1", tag: "button", role: "button", text: "Continue"}],
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
    expect(page.locatorSelectors).toContain('[data-runtime-ref="e1"]');
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
      pageText: "Popup body",
      dialogText: "",
      signals: [],
      elements: [],
    };
    page.onLocatorClick = async () => {
      context.emitPage(popup);
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
      changes: {
        pageSwitched: true,
      },
    });
    expect((result.content[0] as {type: string; text: string}).text).toContain("Switched to a new page");
    expect(page.closed).toBe(true);
  });

  it("caps evaluate results and writes screenshot/pdf artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
    expect((evaluate.details as Record<string, unknown>).result).toBe("\"abcdefghijk");
    expect((evaluate.content[0] as {type: string; text: string}).text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");

    expect(screenshot.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(screenshot.details).toMatchObject({
      action: "screenshot",
      artifact: {
        kind: "image",
        source: "browser",
        mimeType: "image/png",
      },
    });
    expect(pdf.details).toMatchObject({
      action: "pdf",
      artifact: {
        kind: "pdf",
        source: "browser",
        mimeType: "application/pdf",
      },
    });
    const screenshotPath = String((screenshot.details as Record<string, unknown>).path);
    const pdfPath = String((pdf.details as Record<string, unknown>).path);
    await expect(stat(screenshotPath)).resolves.toBeTruthy();
    await expect(stat(pdfPath)).resolves.toBeTruthy();
    await expect(readFile(pdfPath, "utf8")).resolves.toContain("%PDF-test");
  });

  it("returns the explicit evaluate hint when the page script yields nothing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const docker = createDockerExecMock();
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(new FakePage())) as any),
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "evaluate", script: "const x = 1;"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(result.details).toMatchObject({
      action: "evaluate",
      result: null,
      truncated: false,
    });
    expect((result.content[0] as {type: string; text: string}).text).toContain("add an explicit `return`");
  });

  it("renders full snapshots with state badges, signals, and wrapped external content", async () => {
    const docker = createDockerExecMock();
    const page = new FakePage();
    page.snapshot = {
      url: "https://example.com/form",
      title: "Checkout",
      text: "Dialog warning Name field is invalid Continue browsing",
      pageText: "Continue browsing",
      dialogText: "Dialog warning Name field is invalid",
      signals: ["dialog", "validation_error"],
      elements: [
        {
          ref: "e1",
          tag: "input",
          role: "textbox",
          text: "Name",
          value: "x",
          required: true,
          invalid: true,
          section: "dialog",
        },
        {
          ref: "e2",
          tag: "input",
          role: "checkbox",
          text: "Accept terms",
          checked: true,
        },
      ],
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "snapshot", snapshotMode: "full"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    const text = (result.content[0] as {type: string; text: string}).text;
    expect(text).toContain("Signals: dialog, validation_error");
    expect(text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT source=\"browser\" kind=\"snapshot\">>>");
    expect(text).toContain("Dialog / overlay text:");
    expect(text).toContain("- [e1] textbox [dialog] \"Name\" value=\"x\" [required] [invalid]");
    expect(text).toContain("- [e2] checkbox \"Accept terms\" [checked]");
    expect(result.details).toMatchObject({
      action: "snapshot",
      snapshotMode: "full",
      signals: ["dialog", "validation_error"],
      externalContent: {
        source: "browser",
        kind: "snapshot",
      },
    });
  });

  it("surfaces target changes after typing and keeps snapshot refs fresh", async () => {
    const docker = createDockerExecMock();
    const page = new FakePage();
    page.snapshot = {
      url: "https://example.com/form",
      title: "Form",
      text: "Email",
      pageText: "Email",
      dialogText: "",
      signals: [],
      elements: [
        {
          ref: "e1",
          tag: "input",
          role: "textbox",
          text: "Email",
          value: "",
        },
      ],
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "type", ref: "e1", text: "hello@example.com"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(result.details).toMatchObject({
      action: "type",
      changes: {
        target: {
          ref: "e1",
          changed: ["value"],
        },
      },
    });
    expect((result.content[0] as {type: string; text: string}).text).toContain("Target e1 changed: value");
    expect((result.content[0] as {type: string; text: string}).text).toContain("hello@example.com");
  });

  it("returns labeled screenshots with companion snapshot text and cleans overlays up", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const docker = createDockerExecMock();
    const page = new FakePage();
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "screenshot", labels: true},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect((result.content[0] as {type: string; text: string}).text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(result.details).toMatchObject({
      action: "screenshot",
      labels: true,
      snapshotMode: "compact",
      externalContent: {
        source: "browser",
        kind: "snapshot",
      },
    });
    expect(page.labelOverlaysInstalled).toBe(1);
    expect(page.labelOverlaysRemoved).toBe(1);
  });

  it("persists thread-scoped browser storage state across close and reopen", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const docker = createDockerExecMock();
    const firstContext = new FakeBrowserContext(new FakePage());
    const secondContext = new FakeBrowserContext(new FakePage());
    const connectBrowserImpl = vi.fn()
      .mockResolvedValueOnce(new FakeBrowser(firstContext) as any)
      .mockResolvedValueOnce(new FakeBrowser(secondContext) as any);
    const service = new BrowserSessionService({
      execFileImpl: docker.execFileImpl as any,
      connectBrowserImpl: connectBrowserImpl as any,
      dataDir: tempDir,
    });
    services.push(service);

    const run = createRunContext({cwd: "/workspace/panda", threadId: "thread-1"});
    await service.handle({action: "snapshot"}, run);
    await service.handle({action: "close"}, run);
    await service.handle({action: "snapshot"}, run);

    expect(firstContext.storageStatePaths).toHaveLength(2);
    expect(secondContext.storageStateInput).toBeTruthy();
    expect(String(secondContext.storageStateInput)).toContain("storage-state.json");
    await expect(stat(String(secondContext.storageStateInput))).resolves.toBeTruthy();
  });

  it("closes the persistent session and removes the container", async () => {
    const docker = createDockerExecMock();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
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
