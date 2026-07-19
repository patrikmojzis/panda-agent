import {afterEach, describe, expect, it} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import {DataType, newDb} from "pg-mem";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Agent, BashTool, stringToUserMessage, Tool, ToolError, z,} from "../src/index.js";
import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {createClearEnvValueCommand, createSetEnvValueCommand} from "../src/domain/credentials/commands.js";
import {PostgresCredentialStore} from "../src/domain/credentials/postgres.js";
import {CredentialResolver, CredentialService} from "../src/domain/credentials/resolver.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import type {CommandExecutor} from "../src/domain/commands/types.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
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

    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});
    await agentStore.ensureAgentTableSchema();
    await credentialStore.ensureSchema();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
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

  class SetEnvValueTestTool extends Tool<typeof SetEnvValueTestTool.schema, DefaultAgentSessionContext> {
    static schema = z.object({
      key: z.string().trim().min(1),
      value: z.string(),
    });

    name = "set_env_value";
    description = "Set a credential for this test.";
    schema = SetEnvValueTestTool.schema;

    constructor(private readonly commandExecutor: CommandExecutor) {
      super();
    }

    override redactCallArguments(args: Record<string, unknown>): Record<string, unknown> {
      return {
        ...args,
        ...(typeof args.value === "string" ? {value: "[redacted]"} : {}),
      };
    }

    async handle(args: z.output<typeof SetEnvValueTestTool.schema>, run: { context: DefaultAgentSessionContext }) {
      const result = await this.commandExecutor.execute({
        command: "env.set",
        input: args,
        scope: {
          agentKey: run.context.agentKey,
          sessionId: run.context.sessionId,
          threadId: run.context.threadId,
          allowedCommands: ["env.set"],
          credentialMutationAllowed: true,
        },
      });
      if (!result.ok) {
        throw new ToolError(result.error.message);
      }
      return result.output;
    }
  }

  function createEnvCommandExecutor(service: CredentialService) {
    return new RuntimeCommandDispatcher({
      commands: [
        createSetEnvValueCommand(service),
        createClearEnvValueCommand(service),
      ],
    });
  }

  it("requires explicit credential mutation permission for env writes", async () => {
    const {service} = await createHarness();
    const commandExecutor = createEnvCommandExecutor(service);
    const staticScope = {
      agentKey: "panda",
      sessionId: "session-credentials-policy",
      allowedCommands: ["env.set", "env.clear"],
    };
    const denied = {
      ok: false,
      error: {
        code: "forbidden",
        message: "Credential mutation is not allowed in this execution environment.",
        details: {
          failureCode: "command_scope_denied",
          retryable: false,
          nextAction: {
            kind: "stop",
            reason: "The current command lease does not permit credential mutation.",
          },
          exitCode: 3,
        },
      },
    };

    await expect(commandExecutor.execute({
      command: "env.set",
      input: {key: "OPENAI_API_KEY", value: "secret"},
      scope: staticScope,
    })).resolves.toMatchObject(denied);
    await expect(commandExecutor.execute({
      command: "env.clear",
      input: {key: "OPENAI_API_KEY"},
      scope: staticScope,
    })).resolves.toMatchObject(denied);
    await expect(commandExecutor.execute({
      command: "env.set",
      input: {key: "OPENAI_API_KEY", value: "secret"},
      scope: {
        ...staticScope,
        credentialMutationAllowed: true,
      },
    })).resolves.toMatchObject({
      ok: true,
      output: {
        envKey: "OPENAI_API_KEY",
        valueLength: 6,
      },
    });
  });

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
    const commandExecutor = createEnvCommandExecutor(service);
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
      createAssistantMessage([{type: "text", text: "Nothing else to do."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-e2e",
      sessionId: "session-credentials-e2e",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new LeaseManager(),
      resolveDefinition: async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Use tools.",
          tools: [
            new SetEnvValueTestTool(commandExecutor),
            new BashTool({
              credentialResolver: resolver,
              outputDirectory: path.join(workspace, "tool-results"),
            }),
          ],
        }),
        context: {
          agentKey: "panda",
          sessionId: "session-credentials-e2e",
          threadId: "thread-credentials-e2e",
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
      identityId: "alice-id",
    });
    await coordinator.waitForIdle("thread-credentials-e2e");

    await expect(credentialStore.getCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).resolves.toMatchObject({
      agentKey: "panda",
    });

    const transcript = await store.loadTranscript("thread-credentials-e2e");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:set_env_value",
      "assistant",
      "tool:bash",
      "assistant",
      "runtime",
      "assistant",
    ]);
    expect(transcript[1]?.message).toMatchObject({
      role: "assistant",
      content: [{
        type: "toolCall",
        name: "set_env_value",
        arguments: {
          key: "NOTION_API_KEY",
          value: "[redacted]",
        },
      }],
    });
    expect(JSON.stringify(transcript[1]?.message)).not.toContain("notion-secret");
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
    const commandExecutor = createEnvCommandExecutor(service);
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
      createAssistantMessage([{type: "text", text: "Nothing else to do."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-redacted-bash",
      sessionId: "session-credentials-redacted-bash",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new LeaseManager(),
      resolveDefinition: async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Use tools.",
          tools: [
            new SetEnvValueTestTool(commandExecutor),
            new BashTool({
              credentialResolver: resolver,
              outputDirectory: path.join(workspace, "tool-results"),
            }),
          ],
        }),
        context: {
          agentKey: "panda",
          sessionId: "session-credentials-redacted-bash",
          threadId: "thread-credentials-redacted-bash",
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
      identityId: "alice-id",
    });
    await coordinator.waitForIdle("thread-credentials-redacted-bash");

    const transcript = await store.loadTranscript("thread-credentials-redacted-bash");
    expect(transcript[1]?.message).toMatchObject({
      role: "assistant",
      content: [{
        type: "toolCall",
        name: "set_env_value",
        arguments: {
          key: "NOTION_API_KEY",
          value: "[redacted]",
        },
      }],
    });
    expect(JSON.stringify(transcript[1]?.message)).not.toContain("notion-secret");
    expect(JSON.stringify(transcript[2]?.message)).not.toContain("notion-secret");
    expect(transcript[4]?.message).toMatchObject({
      role: "toolResult",
      toolName: "bash",
      details: expect.objectContaining({
        stdout: "[redacted]",
      }),
    });
    expect(JSON.stringify(transcript[4]?.message)).not.toContain("notion-secret");
  });
});
