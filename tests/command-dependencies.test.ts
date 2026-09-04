import {describe, expect, it, vi} from "vitest";

import type {MessageAgentCommandQueue} from "../src/domain/a2a/commands.js";
import type {SubagentSpawnSessionCreator} from "../src/domain/subagents/commands.js";
import {DEFAULT_AGENT_COMMAND_CATALOG, type AgentCommandModuleDependencies} from "../src/panda/commands/agent-command-modules.js";

const scope = {agentKey: "panda", sessionId: "sender-session", threadId: "sender-thread"};

describe("bound command services", () => {
  it("delivers A2A text with the invoking session authority through the assembled catalog", async () => {
    const queueMessage = vi.fn<MessageAgentCommandQueue["queueMessage"]>(async () => ({
      delivery: {id: "delivery-one"}, targetAgentKey: "peer", targetSessionId: "peer-session", messageId: "message-one",
    }));
    const dependencies = {
      a2aMessaging: {queueMessage},
      a2aDeliveries: {
        async getA2ADelivery() { return null; },
        async listA2ADeliveries() { return []; },
      },
      commandUploads: {
        async inspect() { throw new Error("Text delivery must not inspect uploads."); },
        async resolve() { throw new Error("Text delivery must not resolve uploads."); },
        async remove() { throw new Error("Text delivery must not remove uploads."); },
      },
    } satisfies AgentCommandModuleDependencies;
    const commands = DEFAULT_AGENT_COMMAND_CATALOG.createCommands(dependencies, {
      registrationPhase: "daemon.a2a", requireAll: true,
    });
    const send = commands.find((command) => command.descriptor.name === "a2a.send")!;

    await expect(send.execute({
      command: "a2a.send", scope, input: {sessionId: "peer-session", items: [{type: "text", text: "Status update"}]},
    })).resolves.toMatchObject({ok: true, output: {status: "queued", deliveryId: "delivery-one", targetSessionId: "peer-session"}});
    expect(queueMessage).toHaveBeenCalledWith(expect.objectContaining({
      senderAgentKey: "panda", senderSessionId: "sender-session", senderThreadId: "sender-thread", sessionId: "peer-session",
    }));
  });

  it("preserves subagent creation failures and invoking-session authority through its separate registration phase", async () => {
    const createSubagentSession = vi.fn<SubagentSpawnSessionCreator["createSubagentSession"]>(async () => {
      throw new Error("Subagent profile is disabled.");
    });
    const [command] = DEFAULT_AGENT_COMMAND_CATALOG.createCommands(
      {subagentSessions: {createSubagentSession}},
      {registrationPhase: "runtime.subagent", requireAll: true},
    );

    await expect(command!.execute({
      command: "subagent.spawn", scope, input: {profile: "reader", prompt: "Read the report"},
    })).rejects.toThrow("Subagent profile is disabled.");
    expect(createSubagentSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda", parentSessionId: "sender-session", profile: "reader", task: "Read the report",
    }));
  });
});
