import {mkdtemp, rm} from "node:fs/promises";
import {request as httpRequest, type ClientRequest} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {Agent} from "../src/kernel/agent/agent.js";
import {RunContext} from "../src/kernel/agent/run-context.js";
import {BrowserTool} from "../src/panda/tools/browser-tool.js";
import {startBrowserRunner, type BrowserRunner, type BrowserRunnerOptions} from "../src/integrations/browser/runner.js";

type Browser = Awaited<ReturnType<NonNullable<BrowserRunnerOptions["launchBrowserImpl"]>>>;

const snapshot = {
  url: "https://example.test/",
  title: "Example",
  text: "Example body",
  pageText: "Example body",
  dialogText: "",
  signals: [],
  elements: [],
};

function createBrowser(options: {readSnapshot?: () => Promise<typeof snapshot>; onClose?: () => void} = {}) {
  let closed = false;
  const page = {
    url: () => snapshot.url,
    title: async () => snapshot.title,
    isClosed: () => closed,
    evaluate: vi.fn(options.readSnapshot ?? (async () => snapshot)),
    close: async () => { closed = true; },
  };
  const context = {
    newPage: async () => page,
    pages: () => [page],
    route: async () => {},
    on: () => {},
    storageState: vi.fn(async () => ({cookies: [], origins: []})),
    close: vi.fn(async () => { closed = true; }),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    on: () => {},
    close: vi.fn(async () => { options.onClose?.(); }),
  };
  return {browser, context, page, launched: browser as unknown as Browser};
}

describe("browser runner HTTP cancellation", () => {
  const runners: BrowserRunner[] = [];
  const directories: string[] = [];
  const requests: ClientRequest[] = [];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const request of requests.splice(0)) request.destroy();
    for (const runner of runners.splice(0)) await runner.close();
    for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  async function start(launchBrowserImpl: BrowserRunnerOptions["launchBrowserImpl"]) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "browser-runner-cancellation-"));
    directories.push(dataDir);
    const runner = await startBrowserRunner({
      host: "127.0.0.1", port: 0, sharedSecret: "runner-test-secret", dataDir, launchBrowserImpl,
    });
    runners.push(runner);
    return runner;
  }

  function actionBody(sessionId = "session-one") {
    return JSON.stringify({agentKey: "panda", sessionId, threadId: "thread-one", action: {action: "snapshot"}});
  }

  async function readSnapshot(runner: BrowserRunner, sessionId = "session-one") {
    const response = await fetch(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {authorization: "Bearer runner-test-secret", "content-type": "application/json"},
      body: actionBody(sessionId),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ok: true, details: {action: "snapshot", title: "Example"}});
  }

  function openRequest(runner: BrowserRunner, headers: Record<string, string> = {}) {
    const request = httpRequest(`http://127.0.0.1:${runner.port}/action`, {
      method: "POST",
      headers: {authorization: "Bearer runner-test-secret", "content-type": "application/json", ...headers},
    });
    request.on("error", () => {});
    requests.push(request);
    return request;
  }

  it("keeps a session reusable after healthy request-body and response completion", async () => {
    const fixture = createBrowser();
    const launch = vi.fn(async () => fixture.launched);
    const runner = await start(launch);

    await readSnapshot(runner);
    await readSnapshot(runner);

    expect(launch).toHaveBeenCalledOnce();
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
    expect(fixture.browser.close).not.toHaveBeenCalled();
    expect(fixture.context.close).not.toHaveBeenCalled();
  });

  it("does not launch a browser after the caller aborts an incomplete body", async () => {
    const launch = vi.fn(async () => createBrowser().launched);
    const runner = await start(launch);
    let markReceived!: () => void;
    let markClosed!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    runner.server.once("request", (_request, response) => {
      response.once("close", markClosed);
      markReceived();
    });
    const body = actionBody();
    const request = openRequest(runner, {"content-length": String(Buffer.byteLength(body))});
    request.write(body.slice(0, 10));
    await received;
    request.destroy();
    await closed;

    expect(launch).not.toHaveBeenCalled();
    await readSnapshot(runner);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("carries public tool cancellation through HTTP to browser teardown", async () => {
    let markStarted!: () => void;
    let releaseSnapshot!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const cancelled = createBrowser({
      readSnapshot: async () => { markStarted(); await released; return snapshot; },
      onClose: releaseSnapshot,
    });
    const replacement = createBrowser();
    const launch = vi.fn()
      .mockResolvedValueOnce(cancelled.launched)
      .mockResolvedValueOnce(replacement.launched);
    const runner = await start(launch);
    const tool = new BrowserTool({env: {
      BROWSER_RUNNER_URL: `http://127.0.0.1:${runner.port}`,
      BROWSER_RUNNER_SHARED_SECRET: "runner-test-secret",
    }});
    const controller = new AbortController();
    const action = tool.run({action: "snapshot"}, new RunContext({
      agent: new Agent({name: "browser-tool-test", instructions: "test"}),
      turn: 1, maxTurns: 1, messages: [], signal: controller.signal,
      context: {agentKey: "panda", sessionId: "session-one", threadId: "thread-one"},
    }));
    const failed = expect(action).rejects.toMatchObject({
      message: "Browser action was cancelled.", details: {cancelled: true},
    });
    await started;
    controller.abort(new Error("private caller reason"));
    await failed;
    await vi.waitFor(() => expect(cancelled.browser.close).toHaveBeenCalledOnce());
    await readSnapshot(runner);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(replacement.browser.close).not.toHaveBeenCalled();
  });

  it("closes only the disconnected action's browser and allows replacement and other sessions", async () => {
    let markStarted!: () => void;
    let releaseSnapshot!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const disconnected = createBrowser({
      readSnapshot: async () => { markStarted(); await released; return snapshot; },
      onClose: releaseSnapshot,
    });
    const unaffected = createBrowser();
    const replacement = createBrowser();
    const launch = vi.fn()
      .mockResolvedValueOnce(disconnected.launched)
      .mockResolvedValueOnce(unaffected.launched)
      .mockResolvedValueOnce(replacement.launched);
    const runner = await start(launch);
    const request = openRequest(runner);
    request.end(actionBody());
    await started;
    await readSnapshot(runner, "session-two");

    request.destroy();

    await vi.waitFor(() => expect(disconnected.browser.close).toHaveBeenCalledOnce());
    expect(unaffected.browser.close).not.toHaveBeenCalled();
    await readSnapshot(runner);
    await readSnapshot(runner, "session-two");
    expect(launch).toHaveBeenCalledTimes(3);
    expect(unaffected.page.evaluate).toHaveBeenCalledTimes(2);
    expect(replacement.page.evaluate).toHaveBeenCalledOnce();
    expect(disconnected.browser.close).toHaveBeenCalledOnce();
    expect(replacement.browser.close).not.toHaveBeenCalled();
  });
});
