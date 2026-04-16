import {createServer} from "node:http";

import {afterEach, describe, expect, it, vi} from "vitest";
import {Readability} from "@mozilla/readability";

import {Agent, type PandaSessionContext, RunContext, ToolError, WebFetchTool,} from "../src/index.js";
import {
    createPinnedLookup,
    extractReadableContentFromHtml,
    fetchWithPinnedLookup,
} from "../src/panda/tools/web-fetch.js";

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

describe("WebFetchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns readable content, metadata, absolute links, and progress events", async () => {
    const progress: Array<Record<string, unknown>> = [];
    const tool = new WebFetchTool({
      fetchImpl: vi.fn(async () => new Response(`
        <!doctype html>
        <html>
          <head>
            <title>Example Article</title>
            <meta name="description" content="Readable summary.">
            <meta property="og:site_name" content="Example Docs">
          </head>
          <body>
            <main>
              <article>
                <h1>Example Article</h1>
                <p>Hello <a href="/docs">Docs</a>.</p>
                <p>Keep reading <a href="https://other.example/guide">Guide</a>.</p>
                <div aria-hidden="true">hidden junk</div>
              </article>
            </main>
          </body>
        </html>
      `, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      })),
      lookupHostname: async () => ["93.184.216.34"],
    });

    const result = await tool.run(
      {url: "https://example.com/article"},
      createRunContext(
        {cwd: "/workspace/panda"},
        {onToolProgress: (entry) => progress.push(entry)},
      ),
    );

    expect(result).toMatchObject({
      details: {
        url: "https://example.com/article",
        finalUrl: "https://example.com/article",
        status: 200,
        contentType: "text/html",
        title: "Example Article",
        description: "Readable summary.",
        siteName: "Example Docs",
        truncated: false,
        links: [
          {
            text: "Docs",
            url: "https://example.com/docs",
          },
          {
            text: "Guide",
            url: "https://other.example/guide",
          },
        ],
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("# Example Article"),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Source: https://example.com/article"),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[Docs](https://example.com/docs)"),
    });
    expect(progress.map((entry) => entry.status)).toEqual(["validating", "fetching", "extracting"]);
  });

  it("falls back to basic HTML cleanup when Readability returns nothing", () => {
    const parseSpy = vi.spyOn(Readability.prototype, "parse").mockReturnValue(null as any);

    const result = extractReadableContentFromHtml({
      url: "https://example.com/post",
      html: `
        <html>
          <head><title>Fallback Title</title></head>
          <body>
            <div class="hidden">do not show</div>
            <p>Hello <a href="/docs">docs</a>.</p>
          </body>
        </html>
      `,
    });

    expect(parseSpy).toHaveBeenCalledOnce();
    expect(result.title).toBe("Fallback Title");
    expect(result.content).toContain("[docs](https://example.com/docs)");
    expect(result.content).not.toContain("do not show");
    expect(result.links).toEqual([
      {
        text: "docs",
        url: "https://example.com/docs",
      },
    ]);
  });

  it("rejects non-http URLs before doing any network work", async () => {
    const fetchMock = vi.fn();
    const tool = new WebFetchTool({
      fetchImpl: fetchMock as any,
    });

    await expect(tool.run(
      {url: "ftp://example.com/file.txt"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: "url must use http:// or https://.",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-html responses", async () => {
    const tool = new WebFetchTool({
      fetchImpl: vi.fn(async () => new Response("%PDF", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
        },
      })),
      lookupHostname: async () => ["93.184.216.34"],
    });

    await expect(tool.run(
      {url: "https://example.com/file.pdf"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("only supports HTML pages right now"),
    });
  });

  it("surfaces HTTP errors with readable body text", async () => {
    const tool = new WebFetchTool({
      fetchImpl: vi.fn(async () => new Response("<html><body><h1>Nope</h1></body></html>", {
        status: 404,
        statusText: "Not Found",
        headers: {
          "content-type": "text/html",
        },
      })),
      lookupHostname: async () => ["93.184.216.34"],
    });

    await expect(tool.run(
      {url: "https://example.com/missing"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("HTTP 404 Not Found: Nope"),
    });
  });

  it("times out stalled fetches", async () => {
    vi.useFakeTimers();
    const tool = new WebFetchTool({
      timeoutMs: 25,
      lookupHostname: async () => ["93.184.216.34"],
      fetchImpl: vi.fn(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, {once: true});
      })),
    });

    const promise = tool.run(
      {url: "https://example.com/slow"},
      createRunContext({cwd: "/workspace/panda"}),
    );
    await vi.advanceTimersByTimeAsync(30);

    await expect(promise).rejects.toBeInstanceOf(ToolError);
    await expect(promise).rejects.toMatchObject({
      message: "web_fetch timed out after 25ms.",
    });
  });

  it("enforces the response byte cap", async () => {
    const tool = new WebFetchTool({
      maxResponseBytes: 64,
      fetchImpl: vi.fn(async () => new Response(`
        <html>
          <body>${"a".repeat(200)}</body>
        </html>
      `, {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      })),
      lookupHostname: async () => ["93.184.216.34"],
    });

    await expect(tool.run(
      {url: "https://example.com/huge"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("64 byte limit"),
    });
  });

  it("marks readable output as truncated when content exceeds maxContentChars", async () => {
    const tool = new WebFetchTool({
      maxContentChars: 40,
      fetchImpl: vi.fn(async () => new Response(`
        <html>
          <body>
            <article>
              <p>${"trim me ".repeat(30)}</p>
            </article>
          </body>
        </html>
      `, {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      })),
      lookupHostname: async () => ["93.184.216.34"],
    });

    const result = await tool.run(
      {url: "https://example.com/long"},
      createRunContext({cwd: "/workspace/panda"}),
    );

    expect(result).toMatchObject({
      details: {
        truncated: true,
      },
    });
  });

  it("blocks direct private-network targets before fetch", async () => {
    const fetchMock = vi.fn();
    const tool = new WebFetchTool({
      fetchImpl: fetchMock as any,
      lookupHostname: async () => ["127.0.0.1"],
    });

    await expect(tool.run(
      {url: "https://internal.example.test"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("blocked a private address"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 0.0.0.0 aliases before fetch", async () => {
    const fetchMock = vi.fn();
    const tool = new WebFetchTool({
      fetchImpl: fetchMock as any,
    });

    await expect(tool.run(
      {url: "http://0.0.0.0/test"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("blocked a private address"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 loopback aliases before fetch", async () => {
    const fetchMock = vi.fn();
    const tool = new WebFetchTool({
      fetchImpl: fetchMock as any,
    });

    await expect(tool.run(
      {url: "http://[::ffff:7f00:1]/test"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("blocked a private address"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks redirects that land on a private target", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const requestUrl = String(input);
      if (requestUrl === "https://example.com/start") {
        return new Response("", {
          status: 302,
          headers: {
            location: "http://127.0.0.1/secret",
          },
        });
      }

      return new Response("unexpected", {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      });
    });
    const tool = new WebFetchTool({
      fetchImpl: fetchMock,
      lookupHostname: async (hostname) =>
        hostname === "example.com" ? ["93.184.216.34"] : [hostname],
    });

    await expect(tool.run(
      {url: "https://example.com/start"},
      createRunContext({cwd: "/workspace/panda"}),
    )).rejects.toMatchObject({
      message: expect.stringContaining("blocked a private address"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pins the validated DNS results onto the actual request lookup", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end([
        "<html><body>",
        `<h1>${request.headers.host}</h1>`,
        "</body></html>",
      ].join(""));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address.");
      }

      const lookup = createPinnedLookup({
        hostname: "example.com",
        addresses: ["127.0.0.1"],
      });
      const fetched = await fetchWithPinnedLookup(
        new URL(`http://example.com:${address.port}/pinned`),
        {
          lookup,
          headers: {
            "accept-encoding": "identity",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Panda test",
          },
          maxBytes: 10_000,
        },
      );

      expect(fetched.status).toBe(200);
      expect(fetched.bodyText).toContain(`example.com:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
