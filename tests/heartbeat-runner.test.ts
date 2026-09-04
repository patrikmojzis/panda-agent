import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent, stringToUserMessage,} from "../src/index.js";
import {HeartbeatRunner, type HeartbeatRunnerOptions} from "../src/domain/scheduling/heartbeats/runner.js";
import {type SessionHeartbeatRecord, type SessionRecord} from "../src/domain/sessions/index.js";
import {ThreadRuntimeCoordinator,} from "../src/domain/threads/runtime/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import {waitFor} from "./helpers/wait-for.js";

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "openai-responses",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createMockRuntime(...responses: AssistantMessage[]) {
  return {
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more runtime responses queued.");
      }

      return response;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test.");
    }),
  };
}

function heartbeatDeliveryResult(threadId: string) {
  return {
    input: {
      id: "input-1",
      threadId,
      order: 1,
      deliveryMode: "wake" as const,
      status: "pending" as const,
      connectorKey: "",
      source: "heartbeat",
      createdAt: 1,
    },
    disposition: "inserted" as const,
  };
}

function createDueHeartbeatSessionStore(input: {
  heartbeat: SessionHeartbeatRecord;
  session: SessionRecord;
}): {
  getSession: ReturnType<typeof vi.fn>;
  store: HeartbeatRunnerOptions["sessions"];
} {
  let listed = false;
  const getSession = vi.fn(async () => input.session);
  const store: HeartbeatRunnerOptions["sessions"] = {
    getSession,
    getHeartbeat: vi.fn(async () => ({...input.heartbeat})),
    listDueHeartbeats: vi.fn(async () => {
      if (listed) {
        return [];
      }

      listed = true;
      return [input.heartbeat];
    }),
    claimHeartbeat: vi.fn(async (claim) => {
      input.heartbeat.claimedBy = claim.claimedBy;
      input.heartbeat.claimExpiresAt = claim.claimExpiresAt;
      return {...input.heartbeat};
    }),
    recordHeartbeatResult: vi.fn(async () => input.heartbeat),
  };

  return {getSession, store};
}

async function createHarness(options: {
  responseText?: string;
  heartbeatInstructions?: string | null;
  resolvePromptContext?: HeartbeatRunnerOptions["resolvePromptContext"];
} = {}) {
  const db = newDb();
  db.public.registerOperator({
    operator: "*",
    left: DataType.integer,
    right: DataType.interval,
    returns: DataType.interval,
    implementation: (multiple: number, interval: Record<string, number>) => Object.fromEntries(
      Object.entries(interval).map(([unit, value]) => [unit, value * multiple]),
    ),
  });
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  const {identityStore, sessionStore, threadStore: postgresThreadStore} = await createRuntimeStores(pool);
  const threadStore = new TestThreadRuntimeStore();

  const alice = await identityStore.createIdentity({
    id: "alice-id",
    handle: "alice",
    displayName: "Alice",
  });
  await sessionStore.createSession({
    id: "session-main",
    agentKey: "panda",
    kind: "main",
    currentThreadId: "session-thread",
    createdByIdentityId: alice.id,
  });
  await postgresThreadStore.createThread({
    id: "session-thread",
    sessionId: "session-main",
  });
  await threadStore.createThread({
    id: "session-thread",
    sessionId: "session-main",
  });

  const runtime = createMockRuntime(
    createAssistantMessage(options.responseText ?? "Heartbeat handled."),
  );
  const coordinator = new ThreadRuntimeCoordinator({
    store: threadStore,
    maxConcurrentRuns: 1,
    resolveDefinition: async () => ({
      agent: new Agent({
        name: "panda",
        instructions: "Reply briefly.",
      }),
      runtime,
    }),
  });
  await coordinator.handleStoreNotificationStatus("listening");
  await coordinator.start({source: "panda-core", connectorKey: "test", holderId: "heartbeat-runner-test"});

  const errors: unknown[] = [];
  const runner = new HeartbeatRunner({
    sessions: sessionStore,
    coordinator,
    resolvePromptContext: options.resolvePromptContext
      ?? (async () => ({guidance: options.heartbeatInstructions, canConfigureCadence: true})),
    onError: (error) => { errors.push(error); },
  });

  return {
    alice,
    pool,
    threadStore,
    sessionStore,
    coordinator,
    runner,
    runtime,
    errors,
  };
}

describe("HeartbeatRunner", () => {
  const harnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (!harness) {
        continue;
      }

      await harness.coordinator.stop();
      await harness.pool.end();
    }
  });

  it("fires due heartbeats into the current session thread", async () => {
    const harness = await createHarness({
      heartbeatInstructions: "Always check unfinished promises before going quiet.",
    });
    harnesses.push(harness);

    await harness.pool.query(
      `UPDATE "runtime"."session_heartbeats" SET next_fire_at = $2 WHERE session_id = $1`,
      ["session-main", new Date(Date.now() - 1_000)],
    );

    await harness.runner.start();
    await waitFor(async () => {
      const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
      expect(heartbeat?.lastFireAt).toEqual(expect.any(Number));
    });
    await harness.coordinator.waitForIdle("session-thread");
    await harness.runner.stop();

    const transcript = await harness.threadStore.loadTranscriptHistory("session-thread");
    const heartbeatInput = transcript.find((entry) => entry.origin === "input" && entry.source === "heartbeat");
    expect(heartbeatInput?.identityId).toBe(harness.alice.id);
    expect(heartbeatInput?.metadata).toMatchObject({
      heartbeat: {
        kind: "interval",
        sessionId: "session-main",
      },
    });
    expect(heartbeatInput?.message).toMatchObject({
      role: "user",
      content: expect.stringContaining("Always check unfinished promises before going quiet."),
    });
    expect(heartbeatInput?.message).toMatchObject({
      role: "user",
      content: expect.stringContaining("This is a periodic system heartbeat wake."),
    });
    expect(harness.runtime.complete).toHaveBeenCalledTimes(1);

    const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
    expect(heartbeat?.lastFireAt).toEqual(expect.any(Number));
    expect(heartbeat?.lastSkipReason).toBeUndefined();
    expect(heartbeat?.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("skips busy session threads instead of queueing stale heartbeats", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.coordinator.submitInput("session-thread", {
      message: stringToUserMessage("queued work"),
      source: "tui",
    }, "queue");
    await harness.pool.query(
      `UPDATE "runtime"."session_heartbeats" SET next_fire_at = $2 WHERE session_id = $1`,
      ["session-main", new Date(Date.now() - 1_000)],
    );

    await harness.runner.start();
    await waitFor(async () => {
      const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
      expect(heartbeat?.lastSkipReason).toBe("busy");
    });
    await harness.runner.stop();

    const transcript = await harness.threadStore.loadTranscriptHistory("session-thread");
    expect(transcript.some((entry) => entry.origin === "input" && entry.source === "heartbeat")).toBe(false);
    expect(harness.runtime.complete).not.toHaveBeenCalled();

    const heartbeat = await harness.sessionStore.getHeartbeat("session-main");
    expect(heartbeat?.lastFireAt).toBeUndefined();
    expect(heartbeat?.lastSkipReason).toBe("busy");
    expect(heartbeat?.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("preserves a cadence change accepted while delivering the current tick", async () => {
    let accepted: SessionHeartbeatRecord | undefined;
    const scheduledFor = Date.now() - 1_000;
    const harness = await createHarness({
      resolvePromptContext: async () => {
        accepted = await harness.sessionStore.updateHeartbeatConfig({
          sessionId: "session-main", everyMinutes: 15, lastCadenceChangeReason: "An investigation started",
        });
        return {canConfigureCadence: true};
      },
    });
    harnesses.push(harness);
    await harness.pool.query(
      `UPDATE "runtime"."session_heartbeats" SET next_fire_at = $2 WHERE session_id = $1`,
      ["session-main", new Date(scheduledFor)],
    );

    await harness.runner.start();
    await waitFor(async () => {
      expect(harness.errors).toEqual([]);
      expect((await harness.sessionStore.getHeartbeat("session-main"))?.lastFireAt).toEqual(expect.any(Number));
    });
    await harness.runner.stop();
    await expect(harness.sessionStore.getHeartbeat("session-main")).resolves.toMatchObject({
      everyMinutes: 15, nextFireAt: accepted?.nextFireAt, claimedBy: undefined,
      lastCadenceChangeReason: "An investigation started",
    });
    await harness.coordinator.waitForIdle("session-thread");
    const transcript = await harness.threadStore.loadTranscriptHistory("session-thread");
    const heartbeatInput = transcript.find((entry) => entry.origin === "input" && entry.source === "heartbeat");
    expect(heartbeatInput?.message).toMatchObject({content: expect.stringContaining("Current heartbeat interval: 15 minutes.")});
    expect(heartbeatInput?.message).toMatchObject({content: expect.stringContaining("An investigation started")});
    expect(heartbeatInput?.metadata).toMatchObject({heartbeat: {scheduledFor: new Date(scheduledFor).toISOString()}});
  });

  it("does not admit a tick disabled during prompt resolution", async () => {
    const harness = await createHarness({
      resolvePromptContext: async () => {
        await harness.sessionStore.updateHeartbeatConfig({sessionId: "session-main", enabled: false});
        return {canConfigureCadence: false};
      },
    });
    harnesses.push(harness);
    await harness.pool.query(
      `UPDATE "runtime"."session_heartbeats" SET next_fire_at = $2 WHERE session_id = $1`,
      ["session-main", new Date(Date.now() - 1_000)],
    );
    await harness.runner.start();
    await harness.runner.triggerDrain();
    await harness.runner.stop();

    expect(harness.errors).toEqual([]);
    expect(harness.runtime.complete).not.toHaveBeenCalled();
    await expect(harness.sessionStore.getHeartbeat("session-main")).resolves.toMatchObject({
      enabled: false, claimedBy: undefined, lastFireAt: undefined,
    });
  });

  it.each(["expired", "reclaimed"] as const)("does not admit a tick whose claim was %s during prompt resolution", async (change) => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main", enabled: true, everyMinutes: 60, configRevision: 0,
      nextFireAt: Date.now() - 1_000, createdAt: 1, updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({
      heartbeat,
      session: {id: "session-main", agentKey: "panda", kind: "main", currentThreadId: "current-thread", createdAt: 1, updatedAt: 1},
    });
    const coordinator = {
      isThreadBusy: vi.fn(async () => false),
      submitSessionInput: vi.fn(async () => heartbeatDeliveryResult("current-thread")),
    };
    const onError = vi.fn();
    const runner = new HeartbeatRunner({
      sessions, coordinator, onError,
      resolvePromptContext: async () => {
        if (change === "expired") heartbeat.claimExpiresAt = Date.now() - 1;
        else heartbeat.claimedBy = "another-attempt";
        return {canConfigureCadence: true};
      },
    });
    await runner.start();
    await runner.triggerDrain();
    await runner.stop();

    expect(coordinator.submitSessionInput).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("records a skipped heartbeat when the session has no current thread", async () => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      configRevision: 0,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: " ",
      createdAt: 1,
      updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({heartbeat, session});
    const coordinator = {
      isThreadBusy: vi.fn(async () => false),
      submitSessionInput: vi.fn(async () => heartbeatDeliveryResult("unused")),
    };
    const onError = vi.fn();
    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
      onError,
    });

    await runner.start();
    await waitFor(() => {
      expect(sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-main",
        claimedBy: expect.any(String),
        lastSkipReason: "Session session-main has no current thread.",
      }));
    });
    await runner.stop();

    expect(coordinator.isThreadBusy).not.toHaveBeenCalled();
    expect(coordinator.submitSessionInput).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "session-main");
  });

  it("submits heartbeat input to the current thread after the busy check", async () => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      configRevision: 0,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: "old-home",
      createdAt: 1,
      updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({heartbeat, session});
    const submitSessionInput = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe("session-main");
      return heartbeatDeliveryResult("new-home");
    });
    const busyChecks: string[] = [];
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        busyChecks.push(threadId);
        if (threadId === "old-home") {
          session.currentThreadId = "new-home";
        }
        return false;
      }),
      submitSessionInput,
    };

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await waitFor(() => {
      expect(submitSessionInput).toHaveBeenCalled();
    });
    await runner.stop();

    expect(busyChecks).toEqual(["old-home", "new-home"]);
  });

  it("skips when the reset target becomes busy before heartbeat submit", async () => {
    const heartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      configRevision: 0,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: "old-home",
      createdAt: 1,
      updatedAt: 1,
    };
    const {store: sessions} = createDueHeartbeatSessionStore({heartbeat, session});
    const submitSessionInput = vi.fn(async () => heartbeatDeliveryResult("new-home"));
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        if (threadId === "old-home") {
          session.currentThreadId = "new-home";
          return false;
        }
        if (threadId === "new-home") {
          return true;
        }
        throw new Error(`Unexpected heartbeat target ${threadId}`);
      }),
      submitSessionInput,
    };

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await waitFor(() => {
      expect(sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-main",
        claimedBy: expect.any(String),
        lastSkipReason: "busy",
      }));
    });
    await runner.stop();

    expect(coordinator.isThreadBusy).toHaveBeenNthCalledWith(1, "old-home");
    expect(coordinator.isThreadBusy).toHaveBeenNthCalledWith(2, "new-home");
    expect(submitSessionInput).not.toHaveBeenCalled();
  });

  it("re-resolves the session after claim so a reset thread gets the heartbeat", async () => {
    const oldHeartbeat: SessionHeartbeatRecord = {
      sessionId: "session-main",
      enabled: true,
      everyMinutes: 30,
      configRevision: 0,
      nextFireAt: Date.now() - 1_000,
      createdAt: 1,
      updatedAt: 1,
    };

    const {getSession, store: sessions} = createDueHeartbeatSessionStore({
      heartbeat: oldHeartbeat,
      session: {
        id: "session-main",
        agentKey: "panda",
        kind: "main",
        currentThreadId: "new-home",
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const coordinator = {
      isThreadBusy: vi.fn(async (threadId: string) => {
        expect(threadId).toBe("new-home");
        return false;
      }),
      submitSessionInput: vi.fn(async (sessionId: string) => {
        expect(sessionId).toBe("session-main");
        return heartbeatDeliveryResult("new-home");
      }),
    };

    const runner = new HeartbeatRunner({
      sessions,
      coordinator,
    });

    await runner.start();
    await waitFor(() => {
      expect(getSession).toHaveBeenCalledWith("session-main");
    });
    await runner.stop();

    expect(getSession).toHaveBeenCalledWith("session-main");
  });
});
