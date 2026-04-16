import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext} from "../src/index.js";
import {BrowserRunnerClient} from "../src/integrations/browser/client.js";
import {type BrowserRunner, startBrowserRunner} from "../src/integrations/browser/runner.js";

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

class FakePage {
  currentUrl = "https://example.com/";
  currentTitle = "Example";
  closed = false;

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

  async evaluate(_pageFunction: unknown, arg?: unknown): Promise<unknown> {
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

  constructor(private readonly initialPage: FakePage) {}

  async newPage(): Promise<FakePage> {
    this.pagesList.push(this.initialPage);
    return this.initialPage;
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

  async newContext(): Promise<FakeBrowserContext> {
    return this.context;
  }

  async close(): Promise<void> {}

  on(_event: "disconnected", _listener: () => void): void {}
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
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      {action: "snapshot"},
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
      action: {action: "snapshot"},
    });
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
    expect(screenshotPath).toContain(path.join("agents", "panda", "media", "browser", "thread-1"));
    expect((result.content[0] as {type: string; text: string}).text).toContain(screenshotPath);
    await expect(stat(screenshotPath)).resolves.toBeTruthy();
    await expect(readFile(screenshotPath, "utf8")).resolves.toContain("fake-image");
  });

  it("rejects missing and wrong bearer tokens at the runner boundary", async () => {
    const launchBrowserImpl = vi.fn(async () => new FakeBrowser(new FakeBrowserContext(new FakePage())) as any);
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
});
