import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {DEFAULT_IDENTITY_ID} from "../src/domain/identity/index.js";
import {createDaemonThreadHelpers} from "../src/app/runtime/daemon-threads.js";
import {Agent, BashTool, RunContext,} from "../src/index.js";
import {BashJobService} from "../src/integrations/shell/bash-job-service.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function createRunContext(context: Record<string, unknown>): RunContext<Record<string, unknown>> {
  return new RunContext({
    agent: new Agent({
      name: "daemon-threads-test-agent",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

describe("createDaemonThreadHelpers", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("cancels old-thread background jobs during home-thread reset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-daemon-reset-bg-"));
    directories.push(workspace);

    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-old-home",
      agentKey: "panda",
    });

    const bashJobService = new BashJobService({ store });
    const bash = new BashTool({
      outputDirectory: path.join(workspace, "tool-results"),
      jobService: bashJobService,
    });
    const started = await bash.run(
      { command: "sleep 10", background: true },
      createRunContext({
        threadId: "thread-old-home",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      }),
    );
    const jobId = String((started as {jobId: string}).jobId);

    const onTerminalJob = vi.fn();
    bashJobService.setBackgroundCompletionHandler(onTerminalJob);

    let boundThreadId = "thread-old-home";
    const identity = {
      id: DEFAULT_IDENTITY_ID,
      handle: "home",
      displayName: "Home",
      status: "active" as const,
      defaultAgentKey: "panda",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const helpers = createDaemonThreadHelpers({
      fallbackContext: { cwd: workspace },
      model: "openai/gpt-5.1",
      daemonKey: "panda-daemon",
      runtime: {
        store,
        bashJobService,
        coordinator: {
          abort: vi.fn(async () => true),
          waitForCurrentRun: vi.fn(async () => undefined),
        },
        agentStore: {
          getAgent: vi.fn(async () => ({ agentKey: "panda" })),
        },
        identityStore: {
          ensureIdentity: vi.fn(async () => identity),
          getIdentity: vi.fn(async () => identity),
          updateIdentity: vi.fn(async () => identity),
        },
      } as any,
      conversationBindings: {
        bindConversation: vi.fn(async () => undefined),
        getConversationBinding: vi.fn(async () => null),
      } as any,
      homeThreads: {
        resolveHomeThread: vi.fn(async () => ({ threadId: boundThreadId })),
        bindHomeThread: vi.fn(async ({threadId}: {threadId: string}) => {
          boundThreadId = threadId;
        }),
      } as any,
      threadRoutes: {
        saveLastRoute: vi.fn(async () => undefined),
        getLastRoute: vi.fn(async () => null),
      } as any,
      outboundDeliveries: {
        enqueueDelivery: vi.fn(async () => undefined),
      } as any,
      channelActions: {
        enqueueAction: vi.fn(async () => undefined),
      } as any,
      requests: {} as any,
      daemonState: {} as any,
      scheduledTaskRunner: {} as any,
      watchRunner: {} as any,
      relationshipHeartbeatRunner: {} as any,
    });

    const result = await helpers.handleResetHomeThread({
      identityId: DEFAULT_IDENTITY_ID,
      source: "tui",
    });

    expect(result.previousThreadId).toBe("thread-old-home");
    expect(result.threadId).not.toBe("thread-old-home");
    await expect(store.getBashJob(jobId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(onTerminalJob).not.toHaveBeenCalled();
  });
});
