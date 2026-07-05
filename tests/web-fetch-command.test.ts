import {mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {createWebFetchCommand, WEB_FETCH_COMMAND_NAME} from "../src/integrations/web/commands.js";

describe("web fetch command", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop()!, {recursive: true, force: true});
    }
  });

  it("returns readable page content and metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response(`
      <!doctype html>
      <html>
        <head>
          <title>Example Article</title>
          <meta name="description" content="Readable summary.">
          <meta property="og:site_name" content="Example Docs">
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
        maxContentChars: 5000,
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
});
