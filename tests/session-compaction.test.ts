import {randomUUID} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage, Message} from "@earendil-works/pi-ai";
import {Agent, PiAiRuntime, RunContext, Tool, z} from "../src/index.js";
import {createSessionCompactCommand} from "../src/domain/sessions/compaction-commands.js";
import type {SessionCompactionOutcome, SessionCompactionRequest, SessionCompactionStore} from "../src/domain/sessions/compaction.js";
import {processSessionCompaction} from "../src/domain/threads/runtime/session-compaction.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/coordinator.js";
import {compactThread} from "../src/kernel/transcript/compaction.js";
import {renderSessionCompactionOutcome} from "../src/prompts/runtime/compaction.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import {readRunInputContext} from "../src/domain/threads/runtime/input-context.js";

const owner = {source: "test", connectorKey: "compact", holderId: "owner"};
const scope = {agentKey: "panda", sessionId: "session", threadId: "thread"};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-responses", provider: "openai", model: "gpt-5.1",
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
  };
}

class Requests implements SessionCompactionStore {
  pending: SessionCompactionRequest | null = null;
  outcomes: SessionCompactionOutcome[] = [];
  constructor(private readonly threads: TestThreadRuntimeStore) {}
  async request(sessionId: string, _runId: string, instructions: string) {
    this.pending ??= {id: randomUUID(), outcomeId: randomUUID(), sessionId, instructions};
    await this.threads.requestWake("thread");
    return this.pending;
  }
  async read() { return this.pending; }
  async complete(request: SessionCompactionRequest, runId: string, outcome: SessionCompactionOutcome) {
    if (this.pending?.id !== request.id) return null;
    const message = await this.threads.appendRuntimeMessage("thread", {
      source: "runtime", runId,
      metadata: {kind: "session_compaction_outcome", ...outcome},
      message: {role: "user", content: renderSessionCompactionOutcome(outcome), timestamp: 1},
    });
    this.pending = null;
    this.outcomes.push(outcome);
    return message;
  }
}

async function harness(options: {cycles?: number; image?: boolean} = {}) {
  const threads = new TestThreadRuntimeStore();
  const thread = await threads.createThread({id: "thread", sessionId: "session"});
  const request: Message = {
    role: "user", timestamp: 1,
    content: options.image
      ? [{type: "text", text: "Finish the migration. Do not deploy."}, {type: "image", data: "AA==", mimeType: "image/png"}]
      : "Finish the migration. Do not deploy.",
  };
  await threads.enqueueInput("thread", {source: "tui", identityId: "identity", message: request,
    metadata: {route: {source: "telegram", connectorKey: "bot", externalConversationId: "chat"}},
  }, "wake");
  const run = (await threads.tryStartRun("thread", owner, randomUUID()))!;
  await threads.applyPendingInputs("thread", run.id);
  for (let i = 0; i < (options.cycles ?? 6); i++) {
    await threads.appendRuntimeMessage("thread", {runId: run.id, source: "assistant",
      message: assistant([{type: "toolCall", id: `call-${i}`, name: "echo", arguments: {}}]),
    });
    await threads.appendRuntimeMessage("thread", {runId: run.id, source: "tool:echo",
      message: {role: "toolResult", toolCallId: `call-${i}`, toolName: "echo", isError: false, timestamp: 1,
        content: [{type: "text", text: `result-${i} ` + "verbose exploration ".repeat(200)}]},
    });
  }
  const requests = new Requests(threads);
  const command = createSessionCompactCommand(requests);
  const process = async () => processSessionCompaction({
    requests, threads, thread, run, transcript: await threads.loadActiveTranscript("thread"),
    model: "openai/gpt-5.1", signal: new AbortController().signal,
  });
  return {threads, thread, run, requests, command, process, request};
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("agent-requested session compaction", () => {
  it("acknowledges and coalesces requests without running the compressor", async () => {
    const h = await harness();
    const complete = vi.spyOn(PiAiRuntime.prototype, "complete");
    const call = (instructions: string) => h.command.execute({command: "session.compact", input: {instructions}, scope: {...scope, runId: h.run.id}});
    expect(await call("Preserve failures.")).toMatchObject({ok: true, output: {status: "requested", applyAt: "next_model_boundary"}});
    const first = await h.requests.read();
    await call("Duplicate request.");
    expect(await h.requests.read()).toEqual(first);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([{sessionId: "other"}, {model: "other"}, {instructions: null}, {instructions: "x".repeat(4097)}, {instructions: "bad\0text"}])(
    "rejects unsupported input %j", async (input) => {
      const h = await harness({cycles: 0});
      await expect(h.command.execute({command: "session.compact", input, scope: {...scope, runId: h.run.id}})).rejects.toThrow();
      expect(await h.requests.read()).toBeNull();
    },
  );

  it("requires an active run scope", async () => {
    const h = await harness({cycles: 0});
    await expect(h.command.execute({command: "session.compact", input: {}, scope})).rejects.toThrow("active agent run");
  });

  it("compacts one long user turn, keeps complete tool pairs and the verbatim request with its image", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(assistant([{type: "text", text: "<summary>Migration prepared; tests remain.</summary>"}]));
    const h = await harness({image: true});
    await h.command.execute({command: "session.compact", input: {instructions: "Preserve failures."}, scope: {...scope, runId: h.run.id}});
    await h.process();
    const active = await h.threads.loadActiveTranscript("thread");
    expect(h.requests.outcomes[0]).toMatchObject({status: "compacted"});
    expect(active.records[0]?.message.content).toEqual([
      expect.objectContaining({type: "text", text: expect.stringContaining("Migration prepared")}),
      ...(h.request.content as object[]),
    ]);
    expect(active.records.filter((record) => record.message.role === "toolResult").map((record) => record.message.toolCallId))
      .toEqual(["call-4", "call-5"]);
    expect((await h.threads.loadTranscriptHistory("thread")).filter((record) => record.message.role === "toolResult")).toHaveLength(6);
    expect(active.records.at(-1)?.message.content).toContain("Continue your unfinished work");
    expect(readRunInputContext(active.records, true)).toMatchObject({
      identityId: "identity", metadata: {route: {externalConversationId: "chat"}},
    });
  });

  it("keeps automatic compaction's six-turn policy", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const h = await harness();
    await expect(compactThread({store: h.threads, thread: h.thread, model: "openai/gpt-5.1", trigger: "manual", owningRunId: h.run.id})).resolves.toBeNull();
  });

  it("keeps the verbatim task and input provenance through repeated compaction", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(assistant([{type: "text", text: "<summary>Prepared.</summary>"}]));
    const h = await harness();
    const input = readRunInputContext((await h.threads.loadActiveTranscript("thread")).records);
    for (let iteration = 0; iteration < 2; iteration++) {
      if (iteration) {
        for (let i = 0; i < 3; i++) await h.threads.appendRuntimeMessage("thread", {
          source: "assistant", runId: h.run.id,
          message: assistant([{type: "text", text: "Further exploration. ".repeat(500)}]),
        });
      }
      await h.requests.request("session", h.run.id, "");
      await h.process();
      const active = await h.threads.loadActiveTranscript("thread");
      expect(active.records[0]?.message.content).toContain("Finish the migration. Do not deploy.");
      expect(readRunInputContext(active.records)).toEqual(input);
    }
    expect(h.requests.outcomes.map((outcome) => outcome.status)).toEqual(["compacted", "compacted"]);
  });

  it("reports a skip for a short conversation", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const h = await harness({cycles: 1});
    await h.requests.request("session", h.run.id, "");
    await h.process();
    expect(h.requests.outcomes).toEqual([{status: "skipped", reason: expect.any(String)}]);
    expect(await h.requests.read()).toBeNull();
  });

  it("reports provider failure without damaging context or leaking provider error content", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(PiAiRuntime.prototype, "complete").mockRejectedValue(new Error("private-provider-payload"));
    const h = await harness();
    const before = await h.threads.loadActiveTranscript("thread");
    await h.requests.request("session", h.run.id, "");
    await h.process();
    const after = await h.threads.loadActiveTranscript("thread");
    expect(after.records.slice(0, -1)).toEqual(before.records);
    expect(h.requests.outcomes).toEqual([{status: "failed", reason: expect.not.stringContaining("private-provider-payload")}]);
  });

  it("replays a committed checkpoint after an ambiguous commit without recompressing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const complete = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(assistant([{type: "text", text: "<summary>Migration prepared.</summary>"}]));
    const h = await harness();
    await h.requests.request("session", h.run.id, "");
    const commit = h.threads.commitCompaction.bind(h.threads);
    vi.spyOn(h.threads, "commitCompaction").mockImplementationOnce(async (...args) => {
      await commit(...args);
      throw new Error("connection lost after commit");
    });
    await expect(h.process()).rejects.toThrow("connection lost");
    expect(await h.requests.read()).not.toBeNull();
    await h.process();
    expect(h.requests.outcomes).toEqual([{status: "compacted", tokensBefore: expect.any(Number), tokensAfter: expect.any(Number)}]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not compact an unfinished tool batch", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const h = await harness();
    await h.threads.appendRuntimeMessage("thread", {source: "assistant", runId: h.run.id,
      message: assistant([{type: "toolCall", id: "unfinished", name: "echo", arguments: {}}]),
    });
    await h.requests.request("session", h.run.id, "");
    await h.process();
    expect(h.requests.outcomes[0]?.status).toBe("skipped");
  });

  it("accepts the command inside a tool batch and resumes the same run with the rebuilt context", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const h = await harness();
    await h.threads.completeRun(h.run.id);
    class CompactTool extends Tool<typeof CompactTool.schema, {runId: string}> {
      name = "compact_test";
      description = "Request compaction through the CLI command seam.";
      static schema = z.object({});
      schema = CompactTool.schema;
      async handle(_args: object, context: RunContext<{runId: string}>) {
        return h.command.execute({command: "session.compact", input: {}, scope: {...scope, runId: context.context!.runId}});
      }
    }
    const seen: Message[][] = [];
    let step = 0;
    const runtime = {complete: vi.fn(async ({context}) => {
      seen.push(context.messages);
      return step++ === 0
        ? assistant([{type: "toolCall", id: "compact-call", name: "compact_test", arguments: {}}])
        : assistant([{type: "text", text: "Continuing the migration."}]);
    }), stream: vi.fn()};
    const compressor = vi.spyOn(PiAiRuntime.prototype, "complete").mockImplementation(async () => {
      const active = await h.threads.loadActiveTranscript("thread");
      expect(active.records.some((record) => record.message.role === "toolResult" && record.message.toolCallId === "compact-call")).toBe(true);
      return assistant([{type: "text", text: "<summary>Migration prepared.</summary>"}]);
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store: h.threads, sessionCompactionRequests: h.requests, maxConcurrentRuns: 1,
      resolveDefinition: () => ({agent: new Agent({name: "panda", instructions: "Continue", tools: [new CompactTool()]}),
        model: "openai/gpt-5.1", context: {}, runtime}),
    });
    try {
      await coordinator.start(owner);
      await coordinator.submitInput("thread", {source: "heartbeat", message: {role: "user", content: "Continue.", timestamp: 1}});
      await coordinator.waitForIdle("thread");
      expect(compressor).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(seen[1])).toContain("Session compaction compacted");
      expect(JSON.stringify(seen[1])).not.toContain("result-0");
      expect((await h.threads.listRuns("thread")).filter((run) => run.status === "completed")).toHaveLength(2);
    } finally { await coordinator.stop(); }
  });
});
