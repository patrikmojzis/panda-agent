import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext, ToolError,} from "../src/index.js";
import type {BrowserRunner} from "../src/integrations/browser/runner.js";
import {BrowserSessionService} from "../src/integrations/browser/session-service.js";
import {BrowserTool} from "../src/panda/tools/browser-tool.js";

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

class HangingSnapshotPage extends FakePage {
  override async evaluate(pageFunction: unknown, arg?: unknown): Promise<unknown> {
    if (
      arg
      && typeof arg === "object"
      && "script" in arg
      && "maxChars" in arg
    ) {
      return await new Promise(() => undefined);
    }

    return super.evaluate(pageFunction, arg);
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
  websocketRouteHandler: ((route: {
    url(): string;
    close(options?: {code?: number; reason?: string}): Promise<void>;
    connectToServer(): unknown;
  }) => Promise<void>) | null = null;
  private pageListener: ((page: FakePage) => void) | null = null;
  newContextOptions: unknown = undefined;
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

  async routeWebSocket(
    _pattern: string | RegExp,
    handler: (route: {
      url(): string;
      close(options?: {code?: number; reason?: string}): Promise<void>;
      connectToServer(): unknown;
    }) => Promise<void>,
  ): Promise<void> {
    this.websocketRouteHandler = handler;
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

class SlowNewPageContext extends FakeBrowserContext {
  releaseNewPage: (() => void) | null = null;

  override async newPage(): Promise<FakePage> {
    await new Promise<void>((resolve) => {
      this.releaseNewPage = resolve;
    });
    return super.newPage();
  }
}

class FakeBrowser {
  private disconnectListener: (() => void) | null = null;
  closed = false;

  constructor(readonly context: FakeBrowserContext) {}

  async newContext(options?: {storageState?: unknown}): Promise<FakeBrowserContext> {
    this.context.newContextOptions = options;
    this.context.storageStateInput = options?.storageState;
    return this.context;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.disconnectListener?.();
  }

  on(event: "disconnected", listener: () => void): void {
    if (event === "disconnected") {
      this.disconnectListener = listener;
    }
  }
}

describe("BrowserTool", () => {
  const tempDirs: string[] = [];
  const services: BrowserSessionService[] = [];
  const runners: BrowserRunner[] = [];

  afterEach(async () => {
    for (const service of services) {
      await service.close().catch(() => undefined);
    }
    services.length = 0;
    while (runners.length > 0) {
      await runners.pop()?.close();
    }
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

  it("reuses sessions per thread and isolates them across threads", async () => {
    const browserOne = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const browserTwo = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const launchBrowserImpl = vi.fn()
      .mockResolvedValueOnce(browserOne as any)
      .mockResolvedValueOnce(browserTwo as any);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle({action: "snapshot"}, createRunContext({cwd: "/workspace/panda", threadId: "thread-a"}));
    await service.handle({action: "snapshot"}, createRunContext({cwd: "/workspace/panda", threadId: "thread-a"}));
    await service.handle({action: "snapshot"}, createRunContext({cwd: "/workspace/panda", threadId: "thread-b"}));

    expect(launchBrowserImpl).toHaveBeenCalledTimes(2);
  });

  it("closes the launched browser when session startup fails", async () => {
    const browser = {
      newContext: async () => {
        throw new Error("context failed");
      },
      close: vi.fn(async () => {}),
      on: vi.fn(),
    };
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => browser as any),
    });
    services.push(service);

    await expect(service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    )).rejects.toThrow("context failed");

    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("blocks service workers in browser contexts", async () => {
    const context = new FakeBrowserContext(new FakePage());
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
    });
    services.push(service);

    await service.handle(
      {action: "snapshot"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(context.newContextOptions).toMatchObject({
      serviceWorkers: "block",
    });
  });

  it("blocks private targets before navigation starts", async () => {
    const launchBrowserImpl = vi.fn();
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
      lookupHostname: async () => ["127.0.0.1"],
    });
    services.push(service);

    await expect(service.handle(
      {action: "navigate", url: "https://internal.example"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    )).rejects.toBeInstanceOf(ToolError);

    expect(launchBrowserImpl).not.toHaveBeenCalled();
  });

  it("allows explicitly trusted private hosts for Panda-owned internal services", async () => {
    const page = new FakePage();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const launchBrowserImpl = vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any);
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
      lookupHostname: async (hostname) => hostname === "panda-core" ? ["172.22.0.5"] : ["93.184.216.34"],
      allowPrivateHostnames: ["panda-core"],
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "navigate", url: "http://panda-core:8092/panda/apps/period-tracker/"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(launchBrowserImpl).toHaveBeenCalledTimes(1);
    expect(page.url()).toBe("http://panda-core:8092/panda/apps/period-tracker/");
    expect(result.details).toMatchObject({
      action: "navigate",
    });
  });

  it("reads trusted private hosts from BROWSER_ALLOW_PRIVATE_HOSTS", async () => {
    const page = new FakePage();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const launchBrowserImpl = vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any);
    const service = new BrowserSessionService({
      env: {BROWSER_ALLOW_PRIVATE_HOSTS: "panda-core"} as NodeJS.ProcessEnv,
      launchBrowserImpl: launchBrowserImpl as any,
      lookupHostname: async (hostname) => hostname === "panda-core" ? ["172.22.0.5"] : ["93.184.216.34"],
      dataDir: tempDir,
    });
    services.push(service);

    const result = await service.handle(
      {action: "navigate", url: "http://panda-core:8092/panda/apps/period-tracker/"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
    );

    expect(launchBrowserImpl).toHaveBeenCalledTimes(1);
    expect(page.url()).toBe("http://panda-core:8092/panda/apps/period-tracker/");
    expect(result.details).toMatchObject({
      action: "navigate",
    });
  });

  it("blocks redirects that land on a private final URL", async () => {
    const page = new FakePage();
    page.nextGotoUrl = "http://169.254.169.254/latest/meta-data";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
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
    const context = new FakeBrowserContext(new FakePage());
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
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

  it("allows only the active worker preview origin and matching websocket origin", async () => {
    const context = new FakeBrowserContext(new FakePage());
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      lookupHostname: async () => ["172.28.0.12"],
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle(
      {action: "navigate", url: "http://panda-env-worker-a:5173/path"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
      {
        originalOrigin: "http://localhost:5173",
        resolvedOrigin: "http://panda-env-worker-a:5173",
      },
    );

    const routeEvents: string[] = [];
    const route = (url: string) => ({
      request: () => ({url: () => url}),
      abort: async () => {
        routeEvents.push(`abort:${url}`);
      },
      continue: async () => {
        routeEvents.push(`continue:${url}`);
      },
    });
    const websocketRoute = (url: string) => ({
      url: () => url,
      close: async () => {
        routeEvents.push(`ws-close:${url}`);
      },
      connectToServer: () => {
        routeEvents.push(`ws-connect:${url}`);
        return {};
      },
    });

    await context.routeHandler?.(route("http://panda-env-worker-a:5173/src/App.tsx"));
    await context.websocketRouteHandler?.(websocketRoute("ws://panda-env-worker-a:5173/@vite/client"));
    await context.websocketRouteHandler?.(websocketRoute("ws://panda-env-worker-a:5174/@vite/client"));
    await context.routeHandler?.(route("http://panda-env-worker-a:5174/src/App.tsx"));
    await context.routeHandler?.(route("http://panda-env-worker-b:5173/src/App.tsx"));

    expect(routeEvents).toEqual([
      "continue:http://panda-env-worker-a:5173/src/App.tsx",
      "ws-connect:ws://panda-env-worker-a:5173/@vite/client",
      "ws-close:ws://panda-env-worker-a:5174/@vite/client",
      "abort:http://panda-env-worker-a:5174/src/App.tsx",
      "abort:http://panda-env-worker-b:5173/src/App.tsx",
    ]);
  });

  it("clears the worker preview grant on ordinary navigation", async () => {
    const context = new FakeBrowserContext(new FakePage());
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      lookupHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["172.28.0.12"],
      dataDir: tempDir,
    });
    services.push(service);
    const run = createRunContext({cwd: "/workspace/panda", threadId: "thread-1"});

    await service.handle(
      {action: "navigate", url: "http://panda-env-worker-a:5173/"},
      run,
      {
        originalOrigin: "http://localhost:5173",
        resolvedOrigin: "http://panda-env-worker-a:5173",
      },
    );
    await service.handle({action: "navigate", url: "https://example.com/"}, run);

    const routeEvents: string[] = [];
    await context.routeHandler?.({
      request: () => ({url: () => "http://panda-env-worker-a:5173/src/App.tsx"}),
      abort: async () => {
        routeEvents.push("abort");
      },
      continue: async () => {
        routeEvents.push("continue");
      },
    });

    expect(routeEvents).toEqual(["abort"]);
  });

  it("clears the worker preview grant after click navigation leaves the worker origin", async () => {
    const page = new FakePage();
    const context = new FakeBrowserContext(page);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      lookupHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["172.28.0.12"],
      dataDir: tempDir,
    });
    services.push(service);
    const run = createRunContext({cwd: "/workspace/panda", threadId: "thread-1"});

    await service.handle(
      {action: "navigate", url: "http://panda-env-worker-a:5173/"},
      run,
      {
        originalOrigin: "http://localhost:5173",
        resolvedOrigin: "http://panda-env-worker-a:5173",
      },
    );
    page.onLocatorClick = () => {
      page.currentUrl = "https://example.com/";
      page.snapshot = {
        ...page.snapshot,
        url: "https://example.com/",
        title: "Example",
      };
    };
    await service.handle({action: "click", ref: "e1"}, run);

    const routeEvents: string[] = [];
    await context.routeHandler?.({
      request: () => ({url: () => "http://panda-env-worker-a:5173/src/App.tsx"}),
      abort: async () => {
        routeEvents.push("abort");
      },
      continue: async () => {
        routeEvents.push("continue");
      },
    });

    expect(routeEvents).toEqual(["abort"]);
  });

  it("clears the worker preview grant during main-frame navigation away from the worker origin", async () => {
    const context = new FakeBrowserContext(new FakePage());
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
      lookupHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["172.28.0.12"],
      dataDir: tempDir,
    });
    services.push(service);

    await service.handle(
      {action: "navigate", url: "http://panda-env-worker-a:5173/"},
      createRunContext({cwd: "/workspace/panda", threadId: "thread-1"}),
      {
        originalOrigin: "http://localhost:5173",
        resolvedOrigin: "http://panda-env-worker-a:5173",
      },
    );

    const routeEvents: string[] = [];
    await context.routeHandler?.({
      request: () => ({
        url: () => "https://example.com/",
        isNavigationRequest: () => true,
        resourceType: () => "document",
        frame: () => ({parentFrame: () => null}),
      }),
      abort: async () => {
        routeEvents.push("abort:navigate");
      },
      continue: async () => {
        routeEvents.push("continue:navigate");
      },
    });
    await context.routeHandler?.({
      request: () => ({url: () => "http://panda-env-worker-a:5173/src/App.tsx"}),
      abort: async () => {
        routeEvents.push("abort:worker");
      },
      continue: async () => {
        routeEvents.push("continue:worker");
      },
    });

    expect(routeEvents).toEqual(["continue:navigate", "abort:worker"]);
  });

  it("re-checks routed requests instead of caching allow decisions forever", async () => {
    const context = new FakeBrowserContext(new FakePage());
    const lookupHostname = vi.fn(async () => ["93.184.216.34"]);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
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
    const browserOne = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const browserTwo = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const launchBrowserImpl = vi.fn()
      .mockResolvedValueOnce(browserOne as any)
      .mockResolvedValueOnce(browserTwo as any);
    let now = 0;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
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

    expect(launchBrowserImpl).toHaveBeenCalledTimes(2);
    expect(browserOne.closed).toBe(true);
  });

  it("returns compact snapshots with stable refs and uses ref selectors for actions", async () => {
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
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
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
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(context) as any),
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
    const page = new FakePage();
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
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
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(new FakePage())) as any),
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
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
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
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
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
    const page = new FakePage();
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => new FakeBrowser(new FakeBrowserContext(page)) as any),
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
    const firstContext = new FakeBrowserContext(new FakePage());
    const secondContext = new FakeBrowserContext(new FakePage());
    const launchBrowserImpl = vi.fn()
      .mockResolvedValueOnce(new FakeBrowser(firstContext) as any)
      .mockResolvedValueOnce(new FakeBrowser(secondContext) as any);
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
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

  it("closes the persistent session and closes the browser", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-browser-"));
    tempDirs.push(tempDir);
    const browser = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const service = new BrowserSessionService({
      launchBrowserImpl: vi.fn(async () => browser as any),
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
    expect(browser.closed).toBe(true);
  });

  it("times out hung snapshots and discards the dirty session", async () => {
    const firstBrowser = new FakeBrowser(new FakeBrowserContext(new HangingSnapshotPage()));
    const secondBrowser = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const launchBrowserImpl = vi.fn()
      .mockResolvedValueOnce(firstBrowser as any)
      .mockResolvedValueOnce(secondBrowser as any);
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
      actionTimeoutMs: 10,
    });
    services.push(service);

    const run = createRunContext({cwd: "/workspace/panda", threadId: "thread-1"});
    await expect(service.handle({action: "snapshot"}, run))
      .rejects.toThrow(/browser (action snapshot|snapshot) timed out after 10ms/);

    await service.handle({action: "snapshot"}, run);

    expect(launchBrowserImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retain a session that finishes opening after action timeout", async () => {
    const slowContext = new SlowNewPageContext(new FakePage());
    const firstBrowser = new FakeBrowser(slowContext);
    const secondBrowser = new FakeBrowser(new FakeBrowserContext(new FakePage()));
    const launchBrowserImpl = vi.fn()
      .mockResolvedValueOnce(firstBrowser as any)
      .mockResolvedValueOnce(secondBrowser as any);
    const service = new BrowserSessionService({
      launchBrowserImpl: launchBrowserImpl as any,
      actionTimeoutMs: 10,
    });
    services.push(service);

    const run = createRunContext({cwd: "/workspace/panda", threadId: "thread-1"});
    await expect(service.handle({action: "snapshot"}, run))
      .rejects.toThrow("browser action snapshot timed out after 10ms");

    slowContext.releaseNewPage?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.handle({action: "snapshot"}, run);

    expect(firstBrowser.closed).toBe(true);
    expect(launchBrowserImpl).toHaveBeenCalledTimes(2);
  });
});
