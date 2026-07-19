import {mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {createWebFetchCommand, createWebReadCommand, WEB_FETCH_COMMAND_NAME, WEB_READ_COMMAND_NAME} from "../src/integrations/web/commands.js";
import {fetchReadableWebPage} from "../src/integrations/web/web-fetch.js";
import {FileSystemWebResourceStore} from "../src/integrations/web/web-resources.js";

describe("web fetch command", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop()!, {recursive: true, force: true});
    }
  });

  async function createResources(options: {ttlMs?: number} = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-web-resources-"));
    directories.push(root);
    return new FileSystemWebResourceStore({env: {DATA_DIR: root}, ...options});
  }

  it("returns readable page content and metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response(`
      <!doctype html>
      <html>
        <head>
          <title>Example Article</title>
          <meta name="description" content="Readable summary.">
          <meta property="og:site_name" content="Example Docs">
          <link rel="canonical" href="/canonical-article">
        </head>
        <body><main><p>Hello <a href="/docs">Docs</a>.</p></main></body>
      </html>
    `, {
      status: 200,
      headers: {"content-type": "text/html; charset=utf-8"},
    }));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });

    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {
        url: "https://example.com/article",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      status: 200,
      contentType: "text/html",
      title: "Example Article",
      description: "Readable summary.",
      siteName: "Example Docs",
      canonicalUrl: "https://example.com/canonical-article",
      content: expect.stringContaining("Hello"),
      links: [{
        text: "Docs",
        url: "https://example.com/docs",
      }],
    });
  });

  it("saves fetched content and returns a preview instead of the full body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-web-fetch-command-"));
    directories.push(root);
    await mkdir(path.join(root, "workspace"), {recursive: true});
    const savePath = path.join(root, "workspace", "article.md");
    const fetchImpl = vi.fn(async () => new Response(`
      <!doctype html>
      <html>
        <head><title>Saved Article</title></head>
        <body><main><p>${"Long body. ".repeat(200)}</p></main></body>
      </html>
    `, {
      status: 200,
      headers: {"content-type": "text/html; charset=utf-8"},
    }));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
      fileResolver: {
        async resolveWritablePath({file}) {
          expect(file.path).toBe("./article.md");
          return {
            displayPath: file.path,
            path: savePath,
          };
        },
      },
    });

    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {
        url: "https://example.com/article",
        save: "./article.md",
        includeLinks: false,
        chunkChars: 5000,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      title: "Saved Article",
      contentFormat: "markdown",
      saved: {
        path: savePath,
        displayPath: "./article.md",
        format: "markdown",
        bytes: expect.any(Number),
      },
      contentPreview: expect.stringContaining("Long body."),
    });
    expect(result.output).not.toHaveProperty("content");
    expect(result.output).not.toHaveProperty("links");
    await expect(readFile(savePath, "utf8")).resolves.toContain("Long body.");
  });

  it("returns plain content without markdown links when format is text", async () => {
    const fetchImpl = vi.fn(async () => new Response(`
      <!doctype html>
      <html>
        <head><title>Plain Article</title></head>
        <body><main><p>Hello <a href="/docs">Docs</a>.</p></main></body>
      </html>
    `, {
      status: 200,
      headers: {"content-type": "text/html; charset=utf-8"},
    }));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });

    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {
        url: "https://example.com/article",
        format: "text",
        includeLinks: false,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      contentFormat: "text",
      content: expect.stringContaining("Hello Docs."),
    });
    expect(String(result.output.content)).not.toContain("[Docs](");
    expect(result.output).not.toHaveProperty("links");
  });

  it.each([
    ["text/plain", "plain text", "text"],
    ["text/markdown", "# Heading", "markdown"],
    ["application/json", '{"ok":true}', "json"],
    ["application/xml", "<root>ok</root>", "xml"],
    ["text/csv", "name,value\npanda,1", "csv"],
  ])("returns readable %s resources without HTML extraction", async (contentType, body, contentKind) => {
    const command = createWebFetchCommand({
      fetchImpl: async () => new Response(body, {status: 200, headers: {"content-type": contentType}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });
    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/resource"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(result.output).toMatchObject({
      operation: "fetch",
      contentKind,
      content: expect.stringContaining(contentKind === "json" ? '"ok": true' : body),
      contentComplete: true,
      downloadedBytes: Buffer.byteLength(body),
      downloadLimitBytes: 10_000_000,
    });
  });

  it("returns terminal structured failures for invalid JSON and unreadable HTML", async () => {
    const resources = await createResources();
    const scope = {agentKey: "panda", sessionId: "session-1"};
    const invalidJson = createWebFetchCommand({
      fetchImpl: async () => new Response("not json", {headers: {"content-type": "application/json"}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: resources,
    });
    const emptyHtml = createWebFetchCommand({
      fetchImpl: async () => new Response("<html><body><script>render()</script></body></html>", {headers: {"content-type": "text/html"}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: resources,
    });

    await expect(invalidJson.execute({command: WEB_FETCH_COMMAND_NAME, input: {url: "https://example.com/data"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: expect.objectContaining({failureCode: "decode_failed", phase: "decode", retryable: false, nextAction: "curl"})});
    await expect(emptyHtml.execute({command: WEB_FETCH_COMMAND_NAME, input: {url: "https://example.com/app"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: expect.objectContaining({failureCode: "requires_browser", phase: "extract", retryable: false, nextAction: "browser"})});
  });

  it("continues large content without repeating the network request", async () => {
    const fetchImpl = vi.fn(async () => new Response("abcdefghij", {headers: {"content-type": "text/plain"}}));
    const resources = await createResources();
    const fetchCommand = createWebFetchCommand({fetchImpl, lookupHostname: async () => ["93.184.216.34"], resourceStore: resources});
    const readCommand = createWebReadCommand({resourceStore: resources});
    const first = await fetchCommand.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/large.txt", chunkChars: 4},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });
    expect(first.output).toMatchObject({content: expect.stringContaining("abcd"), contentComplete: false, nextCursor: expect.stringMatching(/^cur_/)});

    const second = await readCommand.execute({
      command: WEB_READ_COMMAND_NAME,
      input: {resourceRef: first.output.resourceRef, cursor: first.output.nextCursor, chunkChars: 6},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });
    expect(second.output).toMatchObject({
      content: expect.stringContaining("efghij"),
      contentComplete: true,
      externalContent: {untrusted: true, source: "web", wrappedContent: true},
    });
    expect(String(second.output.content)).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(second.output).not.toHaveProperty("nextCursor");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(readCommand.execute({
      command: WEB_READ_COMMAND_NAME,
      input: {resourceRef: first.output.resourceRef, cursor: "cur_00000000000000000000000000000000"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({pandaCommandErrorDetails: expect.objectContaining({failureCode: "resource_expired", phase: "read"})});
    await expect(readCommand.execute({
      command: WEB_READ_COMMAND_NAME,
      input: {resourceRef: first.output.resourceRef},
      scope: {agentKey: "panda", sessionId: "session-other"},
    })).rejects.toMatchObject({pandaCommandErrorDetails: expect.objectContaining({failureCode: "resource_expired"})});
  });

  it.each([
    ["application/pdf", "%PDF-1.7 fake", "pdf"],
    ["image/png", "\u0089PNG fake", "image"],
    ["application/octet-stream", "binary\0data", "binary"],
  ])("stores bounded %s responses as artifacts", async (contentType, body, contentKind) => {
    const command = createWebFetchCommand({
      fetchImpl: async () => new Response(Buffer.from(body, "latin1"), {headers: {"content-type": contentType}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });
    const result = await command.execute({command: WEB_FETCH_COMMAND_NAME, input: {url: "https://example.com/file.bin"}, scope: {agentKey: "panda", sessionId: "session-1"}});
    expect(result.output).toMatchObject({contentKind, artifact: {path: expect.any(String), mimeType: contentType}});
    expect(result.output).not.toHaveProperty("content");
    await expect(readFile(String((result.output.artifact as {path: string}).path))).resolves.toEqual(Buffer.from(body, "latin1"));
    if (contentKind === "pdf" || contentKind === "image") {
      expect(result.artifact).toMatchObject({kind: contentKind, source: "view_media", path: expect.any(String)});
    } else {
      expect(result).not.toHaveProperty("artifact");
    }
  });

  it("hard-rejects removed maxContentChars before fetching", async () => {
    const fetchImpl = vi.fn();
    const command = createWebFetchCommand({fetchImpl, resourceStore: await createResources()});
    await expect(command.execute({command: WEB_FETCH_COMMAND_NAME, input: {url: "https://example.com", maxContentChars: 10}, scope: {agentKey: "panda", sessionId: "session-1"}}))
      .rejects.toThrow("web.fetch maxContentChars was removed; use chunkChars.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([429, 502, 503, 504])("retries transient HTTP %s failures inside one logical invocation", async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", {status, headers: status === 429 ? {"retry-after": "1"} : {}}))
      .mockResolvedValueOnce(new Response("recovered", {status: 200, headers: {"content-type": "text/plain"}}));
    const waitForRetry = vi.fn(async () => undefined);
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
      random: () => 0.5,
      waitForRetry,
    });

    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(result.output).toMatchObject({attemptCount: 2, content: expect.stringContaining("recovered")});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledTimes(1);
    expect(waitForRetry).toHaveBeenCalledWith(status === 429 ? 1_000 : 100, undefined);
  });

  it("stops transient retries after three attempts", async () => {
    const fetchImpl = vi.fn(async () => new Response("still unavailable", {status: 503}));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
      random: () => 0.5,
      waitForRetry: vi.fn(async () => undefined),
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: expect.objectContaining({
        failureCode: "remote_server_error",
        retryable: true,
        attemptCount: 3,
      }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honors an HTTP-date Retry-After value within the bounded backoff", async () => {
    const nowMs = Date.parse("2026-07-19T00:00:00.000Z");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("later", {
        status: 429,
        headers: {"retry-after": "Sun, 19 Jul 2026 00:00:01 GMT"},
      }))
      .mockResolvedValueOnce(new Response("ok", {headers: {"content-type": "text/plain"}}));
    const waitForRetry = vi.fn(async () => undefined);
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
      now: () => nowMs,
      random: () => 0.5,
      waitForRetry,
    });

    await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });
    expect(waitForRetry).toHaveBeenCalledWith(1_000, undefined);
  });

  it("retries immediately when Retry-After is zero", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("later", {status: 429, headers: {"retry-after": "0"}}))
      .mockResolvedValueOnce(new Response("ok", {headers: {"content-type": "text/plain"}}));
    const waitForRetry = vi.fn(async () => undefined);
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
      waitForRetry,
    });

    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });
    expect(result.output).toMatchObject({attemptCount: 2});
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("treats HTTP %s as terminal and redacts the response body", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("SECRET_RESPONSE_BODY", {status, headers: {"content-type": "text/plain"}}));
    const waitForRetry = vi.fn(async () => undefined);
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      maxResponseBytes: 3,
      resourceStore: await createResources(),
      waitForRetry,
    });

    const failure = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/denied"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: `web.fetch failed with HTTP ${status}.`,
      pandaCommandErrorDetails: {
        failureCode: status === 404 ? "remote_not_found" : "remote_denial",
        phase: "download",
        retryable: false,
        status,
        nextAction: "stop",
      },
    });
    expect(String(failure)).not.toContain("SECRET_RESPONSE_BODY");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("does not retry a response that exceeds the download-byte limit", async () => {
    const fetchImpl = vi.fn(async () => new Response("oversized", {headers: {"content-type": "text/plain"}}));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      maxResponseBytes: 3,
      resourceStore: await createResources(),
      waitForRetry: vi.fn(async () => undefined),
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/large"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: expect.objectContaining({
        failureCode: "response_too_large",
        phase: "download",
        retryable: false,
        downloadLimitBytes: 3,
      }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies the operator-configured download limit to decoded response bytes", async () => {
    const fetchImpl = vi.fn(async () => new Response("decoded-body", {
      headers: {"content-type": "text/plain", "content-encoding": "gzip", "content-length": "2"},
    }));
    const command = createWebFetchCommand({
      env: {WEB_FETCH_DOWNLOAD_LIMIT_BYTES: "4"},
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/compressed"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: expect.objectContaining({failureCode: "response_too_large", downloadLimitBytes: 4}),
    });
  });

  it("fails fast on an invalid operator download limit", () => {
    expect(() => createWebFetchCommand({env: {WEB_FETCH_DOWNLOAD_LIMIT_BYTES: "1.5"}}))
      .toThrow("WEB_FETCH_DOWNLOAD_LIMIT_BYTES must be an integer from 1 to 104857600.");
  });

  it("aborts while waiting to retry", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("retry", {status: 503}));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
      signal: controller.signal,
      waitForRetry: async (_delayMs, signal) => {
        controller.abort();
        expect(signal?.aborted).toBe(true);
        throw new Error("aborted");
      },
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: expect.objectContaining({failureCode: "timeout", retryable: false, nextAction: "stop"}),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("expires resources and rejects traversal-shaped refs", async () => {
    const resources = await createResources();
    const fetchCommand = createWebFetchCommand({
      fetchImpl: async () => new Response("abcdefghij", {headers: {"content-type": "text/plain"}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: resources,
    });
    const readCommand = createWebReadCommand({resourceStore: resources});
    const scope = {agentKey: "panda", sessionId: "session-1"};
    const first = await fetchCommand.execute({command: WEB_FETCH_COMMAND_NAME, input: {url: "https://example.com", chunkChars: 4}, scope});
    await resources.sweep(scope, Date.now() + 2 * 60 * 60 * 1_000);

    await expect(readCommand.execute({command: WEB_READ_COMMAND_NAME, input: {resourceRef: first.output.resourceRef}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: expect.objectContaining({failureCode: "resource_expired"})});
    await expect(readCommand.execute({command: WEB_READ_COMMAND_NAME, input: {resourceRef: "../../etc/passwd"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: expect.objectContaining({failureCode: "resource_expired"})});
  });

  it("enforces bounded session resource storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-web-resources-"));
    directories.push(root);
    const command = createWebFetchCommand({
      fetchImpl: async () => new Response("12345", {headers: {"content-type": "text/plain"}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: new FileSystemWebResourceStore({env: {DATA_DIR: root}, maxScopeBytes: 4}),
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/resource"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: expect.objectContaining({failureCode: "storage_failed", phase: "store", retryable: false}),
    });
  });

  it("conservatively routes mislabeled binary text to an artifact", async () => {
    const command = createWebFetchCommand({
      fetchImpl: async () => new Response(Buffer.from("text\0binary"), {headers: {"content-type": "text/plain"}}),
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });
    const result = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/mislabeled"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(result.output).toMatchObject({contentKind: "binary", artifact: {mimeType: "text/plain"}});
    expect(result.output).not.toHaveProperty("content");
  });

  it("blocks private targets before network access without exposing the address", async () => {
    const fetchImpl = vi.fn();
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["127.0.0.1"],
      resourceStore: await createResources(),
    });

    const failure = await command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://private.example/secret"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: "web.fetch blocked a private target.",
      pandaCommandErrorDetails: expect.objectContaining({failureCode: "private_target", phase: "resolve", retryable: false}),
    });
    expect(String(failure)).not.toContain("127.0.0.1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "ftp://example.com/file",
    "https://user:secret@example.com/file",
  ])("rejects invalid public fetch URL %s before network access", async (url) => {
    const fetchImpl = vi.fn();
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async () => ["93.184.216.34"],
      resourceStore: await createResources(),
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      message: "web.fetch requires a valid public HTTP/HTTPS URL.",
      pandaCommandErrorDetails: expect.objectContaining({failureCode: "invalid_url", phase: "validate", retryable: false}),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates redirects and blocks a private redirect target", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {status: 302, headers: {location: "https://private.example/secret"}}));
    const command = createWebFetchCommand({
      fetchImpl,
      lookupHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["127.0.0.1"],
      resourceStore: await createResources(),
    });

    await expect(command.execute({
      command: WEB_FETCH_COMMAND_NAME,
      input: {url: "https://example.com/start"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      message: "web.fetch blocked a private target.",
      pandaCommandErrorDetails: expect.objectContaining({failureCode: "private_target", retryable: false}),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the watch-facing readable HTML behavior unchanged", async () => {
    const result = await fetchReadableWebPage("https://example.com/article", {
      fetchImpl: async () => new Response("<html><body><main><p>abcdefghij</p></main></body></html>", {headers: {"content-type": "text/html"}}),
      lookupHostname: async () => ["93.184.216.34"],
      maxContentChars: 4,
    });

    expect(result).toMatchObject({content: "abcd", truncated: true, contentType: "text/html"});
    await expect(fetchReadableWebPage("https://example.com/plain", {
      fetchImpl: async () => new Response("plain", {headers: {"content-type": "text/plain"}}),
      lookupHostname: async () => ["93.184.216.34"],
    })).rejects.toThrow("web.fetch only supports HTML pages right now");
  });
});
