import {getEventListeners} from "node:events";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {Agent} from "../src/kernel/agent/agent.js";
import {RunContext} from "../src/kernel/agent/run-context.js";
import type {BrowserRuntimeContext} from "../src/integrations/browser/shared.js";
import {BrowserTool} from "../src/panda/tools/browser-tool.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile)};
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const cancelledError = {message: "Browser action was cancelled.", details: {cancelled: true}};
const artifactBytes = Buffer.from("local screenshot fixture");
const runnerPath = "/runner/screenshot.png";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {promise, resolve};
}

function screenshotResponse() {
  return {
    ok: true,
    text: `Browser screenshot saved to ${runnerPath}`,
    details: {action: "screenshot", path: runnerPath, bytes: artifactBytes.length},
    artifact: {
      kind: "image", mimeType: "image/png", data: artifactBytes.toString("base64"),
      path: runnerPath, bytes: artifactBytes.length,
    },
  };
}

function runContext(signal?: AbortSignal) {
  return new RunContext<BrowserRuntimeContext>({
    agent: new Agent({name: "browser-client-test", instructions: "Use tools"}),
    turn: 1, maxTurns: 1, messages: [], signal,
    context: {agentKey: "panda", sessionId: "session-one", threadId: "thread-one"},
  });
}

describe("browser client cancellation through BrowserTool.run", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "browser-client-cancellation-"));
    vi.mocked(mkdir).mockReset().mockImplementation(actualFs.mkdir);
    vi.mocked(writeFile).mockReset().mockImplementation(actualFs.writeFile);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  function tool(fetchImpl: typeof fetch) {
    return new BrowserTool<BrowserRuntimeContext>({
      env: {BROWSER_RUNNER_URL: "https://runner.example.test", BROWSER_RUNNER_SHARED_SECRET: "test-only-secret"},
      fetchImpl, dataDir,
    });
  }

  it.each(["private abort reason", new Error("private abort reason")])(
    "rejects pre-aborted calls without fetching or exposing %s",
    async (reason) => {
      const caller = new AbortController();
      caller.abort(reason);
      const fetchImpl = vi.fn(async () => Response.json(screenshotResponse()));

      await expect(tool(fetchImpl).run({action: "screenshot"}, runContext(caller.signal)))
        .rejects.toMatchObject(cancelledError);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(getEventListeners(caller.signal, "abort")).toEqual([]);
    },
  );

  it.each(["fetch", "successful body", "error body"])(
    "returns cancellation while an ignored-abort %s is pending, without later persistence or retry",
    async (stage) => {
      const entered = deferred();
      const release = deferred();
      const settled = deferred();
      let requestSignal: AbortSignal | undefined;
      const response = Response.json(screenshotResponse(), {status: stage === "error body" ? 503 : 200});
      const readBody = vi.spyOn(response, "json").mockImplementation(async () => {
        if (stage !== "fetch") {
          entered.resolve();
          await release.promise;
          settled.resolve();
        }
        return screenshotResponse();
      });
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        if (stage === "fetch") {
          entered.resolve();
          await release.promise;
          settled.resolve();
        }
        return response;
      });
      const caller = new AbortController();
      const result = tool(fetchImpl).run({action: "screenshot"}, runContext(caller.signal));
      const rejected = expect(result).rejects.toMatchObject(cancelledError);
      try {
        await entered.promise;
        caller.abort(new Error("private abort reason"));
        await rejected;
        expect(requestSignal?.aborted).toBe(true);
        expect(getEventListeners(caller.signal, "abort")).toEqual([]);
      } finally {
        release.resolve();
      }
      await settled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(readBody).toHaveBeenCalledTimes(stage === "fetch" ? 0 : 1);
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(await readdir(dataDir)).toEqual([]);
    },
  );

  it("does not start an artifact write after a cancelled directory creation eventually finishes", async () => {
    const entered = deferred();
    const release = deferred();
    const settled = deferred();
    vi.mocked(mkdir).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      const result = await actualFs.mkdir(...args);
      settled.resolve();
      return result;
    });
    const caller = new AbortController();
    const fetchImpl = vi.fn(async () => Response.json(screenshotResponse()));
    const result = tool(fetchImpl).run({action: "screenshot"}, runContext(caller.signal));
    const rejected = expect(result).rejects.toMatchObject(cancelledError);
    try {
      await entered.promise;
      caller.abort("private abort reason");
      await rejected;
    } finally {
      release.resolve();
    }
    await settled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(writeFile).not.toHaveBeenCalled();
    expect(await readdir(path.join(dataDir, "agents/panda/media/browser/thread-one"))).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["completes", "fails after writing"])(
    "removes only the cancelled artifact when its ignored-abort write later %s",
    async (outcome) => {
      const entered = deferred();
      const release = deferred();
      const settled = deferred();
      let cancelledPath = "";
      vi.mocked(writeFile).mockImplementationOnce(async (file, bytes) => {
        cancelledPath = String(file);
        entered.resolve();
        await release.promise;
        await actualFs.writeFile(file, bytes);
        settled.resolve();
        if (outcome === "fails after writing") throw new Error("late write failure");
      });
      const fetchImpl = vi.fn(async () => Response.json(screenshotResponse()));
      const browser = tool(fetchImpl);
      const caller = new AbortController();
      const result = browser.run({action: "screenshot"}, runContext(caller.signal));
      const rejected = expect(result).rejects.toMatchObject(cancelledError);
      let survivingPath = "";
      try {
        await entered.promise;
        caller.abort(new Error("private abort reason"));
        await rejected;
        const survivor = await browser.run({action: "screenshot"}, runContext());
        survivingPath = String(vi.mocked(writeFile).mock.calls[1]?.[0]);
        expect(survivor).toMatchObject({
          content: [{type: "text", text: `Browser screenshot saved to ${survivingPath}`}, {
            type: "image", data: artifactBytes.toString("base64"), mimeType: "image/png",
          }],
          details: {path: survivingPath, bytes: artifactBytes.length},
        });
        expect(await readFile(survivingPath)).toEqual(artifactBytes);
      } finally {
        release.resolve();
      }
      await settled.promise;
      await vi.waitFor(async () => {
        expect(await readdir(path.dirname(cancelledPath))).toEqual([path.basename(survivingPath)]);
      });
      expect(await readFile(survivingPath)).toEqual(artifactBytes);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["caller", "deadline"])("preserves %s-first attribution while fetch ignores both aborts", async (first) => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      entered.resolve();
      return await release.promise;
    });
    const caller = new AbortController();
    const expected = first === "caller" ? cancelledError : {message: "Browser runner did not respond within 5010ms."};
    const result = tool(fetchImpl).run({action: "snapshot", timeoutMs: 10}, runContext(caller.signal));
    const rejected = expect(result).rejects.toMatchObject(expected);
    try {
      await entered.promise;
      if (first === "caller") caller.abort("private abort reason");
      await vi.advanceTimersByTimeAsync(5010);
      if (first === "deadline") caller.abort("private abort reason");
      await rejected;

      expect(requestSignal?.aborted).toBe(true);
      expect(requestSignal?.reason).toMatchObject(expected);
      expect(getEventListeners(caller.signal, "abort")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve(Response.json({ok: true, text: "late result"}));
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["success", "runner failure"])("cleans timers and caller listeners after %s", async (outcome) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return Response.json(outcome === "success"
        ? {ok: true, text: "snapshot result"}
        : {ok: false, error: "runner failure", details: {action: "snapshot"}},
      {status: outcome === "success" ? 200 : 500});
    });
    const caller = new AbortController();
    const result = tool(fetchImpl).run({action: "snapshot", timeoutMs: 10}, runContext(caller.signal));
    if (outcome === "success") {
      await expect(result).resolves.toEqual({content: [{type: "text", text: "snapshot result"}]});
    } else {
      await expect(result).rejects.toMatchObject({message: "runner failure", details: {action: "snapshot"}});
    }

    expect(getEventListeners(caller.signal, "abort")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    caller.abort("abort after settlement");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestSignal?.aborted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
