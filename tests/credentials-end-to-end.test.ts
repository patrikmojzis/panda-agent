import {afterEach, describe, expect, it} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Agent, BashTool, stringToUserMessage,} from "../src/index.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {
    CredentialCrypto,
    CredentialResolver,
    CredentialService,
    PostgresCredentialStore,
} from "../src/domain/credentials/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import {SetEnvValueTool} from "../src/panda/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

describe("credentials end-to-end", () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }

    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function createHarness() {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await credentialStore.ensureSchema();

    await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    const crypto = new CredentialCrypto("e2e-master-key");
    const resolver = new CredentialResolver({
      store: credentialStore,
      crypto,
    });
    const service = new CredentialService({
      store: credentialStore,
      crypto,
    });
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-credentials-e2e-"));
    directories.push(workspace);

    return {
      credentialStore,
      resolver,
      service,
      workspace,
    };
  }

  function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
    return {
      role: "assistant",
      content,
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
      stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
  }

  function createMockRuntime(...responses: AssistantMessage[]) {
    return {
      complete: async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error("No more runtime responses queued.");
        }

        return next;
      },
      stream: () => {
        throw new Error("Streaming was not expected in this test.");
      },
    };
  }

  class LeaseManager {
    async tryAcquire(threadId: string) {
      return {
        threadId,
        release: async () => {},
      };
    }
  }

  it("stores a credential and injects it into a later bash call in the same thread", async () => {
    const {credentialStore, resolver, service, workspace} = await createHarness();
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_set_env",
        name: "set_env_value",
        arguments: {
          key: "NOTION_API_KEY",
          value: "notion-secret",
        },
      }]),
      createAssistantMessage([{
        type: "toolCall",
        id: "call_bash",
        name: "bash",
        arguments: {
          command: 'test -n "$NOTION_API_KEY" && printf ok',
        },
      }]),
      createAssistantMessage([{type: "text", text: "Stored and verified."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-e2e",
      sessionId: "session-credentials-e2e",
      context: {
        sessionId: "session-credentials-e2e",
        agentKey: "panda",
      },
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new LeaseManager(),
      resolveDefinition: async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Use tools.",
          tools: [
            new SetEnvValueTool({service}),
            new BashTool({
              credentialResolver: resolver,
              outputDirectory: path.join(workspace, "tool-results"),
            }),
          ],
        }),
        context: {
          agentKey: "panda",
          cwd: workspace,
          shell: {
            cwd: workspace,
            env: {},
          },
        },
        runtime,
      }),
    });

    await coordinator.submitInput("thread-credentials-e2e", {
      message: stringToUserMessage("Store my Notion key and make sure bash sees it."),
      source: "tui",
      identityId: "local",
    });
    await coordinator.waitForIdle("thread-credentials-e2e");

    await expect(credentialStore.getCredentialExact("NOTION_API_KEY", {
      scope: "relationship",
      agentKey: "panda",
      identityId: "local",
    })).resolves.toMatchObject({
      scope: "relationship",
    });

    const transcript = await store.loadTranscript("thread-credentials-e2e");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:set_env_value",
      "assistant",
      "tool:bash",
      "assistant",
    ]);
    expect(JSON.stringify(transcript[2]?.message)).not.toContain("notion-secret");
    expect(transcript[4]?.message).toMatchObject({
      role: "toolResult",
      toolName: "bash",
      details: expect.objectContaining({
        stdout: "ok",
      }),
    });
  });

  it("redacts secret bash output before it reaches the transcript", async () => {
    const {resolver, service, workspace} = await createHarness();
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_set_secret",
        name: "set_env_value",
        arguments: {
          key: "NOTION_API_KEY",
          value: "notion-secret",
        },
      }]),
      createAssistantMessage([{
        type: "toolCall",
        id: "call_echo_secret",
        name: "bash",
        arguments: {
          command: 'printf %s "$NOTION_API_KEY"',
        },
      }]),
      createAssistantMessage([{type: "text", text: "Done."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-redacted-bash",
      sessionId: "session-credentials-redacted-bash",
      context: {
        sessionId: "session-credentials-redacted-bash",
        agentKey: "panda",
      },
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new LeaseManager(),
      resolveDefinition: async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Use tools.",
          tools: [
            new SetEnvValueTool({service}),
            new BashTool({
              credentialResolver: resolver,
              outputDirectory: path.join(workspace, "tool-results"),
            }),
          ],
        }),
        context: {
          agentKey: "panda",
          cwd: workspace,
          shell: {
            cwd: workspace,
            env: {},
          },
        },
        runtime,
      }),
    });

    await coordinator.submitInput("thread-credentials-redacted-bash", {
      message: stringToUserMessage("Save my key and print it"),
      source: "tui",
      identityId: "local",
    });
    await coordinator.waitForIdle("thread-credentials-redacted-bash");

    const transcript = await store.loadTranscript("thread-credentials-redacted-bash");
    expect(JSON.stringify(transcript)).not.toContain("notion-secret");
    expect(transcript[4]?.message).toMatchObject({
      role: "toolResult",
      toolName: "bash",
      details: expect.objectContaining({
        stdout: "[redacted]",
      }),
    });
  });
});
