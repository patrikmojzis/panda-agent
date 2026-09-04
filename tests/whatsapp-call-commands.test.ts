import {describe, expect, it, vi} from "vitest";
import {CommandStructuredError} from "../src/domain/commands/errors.js";
import {LiveVoiceTurnNotFoundError} from "../src/domain/live-voice/types.js";
import {VoiceControlWaitTimeoutError} from "../src/integrations/voice/control-errors.js";

import {createWhatsAppCallSendCommand, createWhatsAppCallStatusCommand, type WhatsAppCallCommandServices} from "../src/integrations/channels/whatsapp/calls/commands.js";

function services(): WhatsAppCallCommandServices & {enqueueControl: ReturnType<typeof vi.fn>} {
  const enqueueControl = vi.fn(async (input) => ({...input, id: "control-1", status: "pending", createdAt: 1, updatedAt: 1}));
  return {
    env: {PANDA_LIVE_VOICE_ENABLED: "true"},
    connectorAccounts: {listAccounts: vi.fn(async () => [{id: "a", source: "whatsapp", accountKey: "main", connectorKey: "connector-1", ownerKind: "agent", ownerIdentityId: null, ownerAgentKey: "panda", status: "enabled", config: {mode: "meta_cloud", calling: {enabled: true, phoneNumberId: "1", wabaId: "2", graphVersion: "v23.0"}}, createdAt: 1, updatedAt: 1}])},
    conversations: {listConversationBindings: vi.fn(async () => [{source: "whatsapp", connectorKey: "connector-1", externalConversationId: "421@s.whatsapp.net", sessionId: "session-1", createdAt: 1, updatedAt: 1}])},
    calls: {
      controls: {enqueueControl, waitForControl: vi.fn(async () => ({id: "control-1", connectorKey: "connector-1", operation: "send", sessionId: "session-1", agentKey: "panda", callId: "wacid.test", status: "completed", result: {ok: true, state: "sent"}, createdAt: 1, updatedAt: 2}))},
      live: {
        listSessions: vi.fn(async () => [{id: "voice-1", source: "whatsapp", connectorKey: "connector-1", scopeKey: "wacid.test", roomKey: "wacid.test", sessionId: "session-1", agentKey: "panda", provider: "openai-live", model: "gpt-live-1-codex", voice: "cove", state: "connected", healthReasons: [], startedAt: 1, updatedAt: 1}]),
        getTurn: vi.fn(async (id) => { throw new LiveVoiceTurnNotFoundError(id); }), listRunningTurns: vi.fn(async () => []),
      },
    },
    enqueueControl,
  };
}

describe("WhatsApp call commands", () => {
  const scope = {agentKey: "panda", sessionId: "session-1"};

  it("keeps disabled calls from enqueueing work", async () => {
    const input = services();
    input.env.PANDA_LIVE_VOICE_ENABLED = "false";
    await expect(createWhatsAppCallSendCommand(input).execute({command: "whatsapp.call.send", input: {text: "Done."}, scope}))
      .rejects.toMatchObject({pandaCommandErrorDetails: {failureCode: "voice_disabled", retryable: false}});
    expect(input.enqueueControl).not.toHaveBeenCalled();
  });

  it("keeps an unknown explicit turn distinct from an unreadable turn", async () => {
    const input = services();
    await expect(createWhatsAppCallSendCommand(input).execute({command: "whatsapp.call.send", input: {text: "Done.", voiceTurnId: "11111111-1111-4111-8111-111111111111"}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "conflict", pandaCommandErrorDetails: {failureCode: "voice_turn_conflict", retryable: false}});
    expect(input.enqueueControl).not.toHaveBeenCalled();
  });

  it.each(["wait", "turn"] as const)("reports an unreadable %s without exposing database connection details", async (operation) => {
    const input = services();
    const cause = new Error("database connection failed: postgres://private-user:private-password@private-host/db");
    vi.mocked(operation === "wait" ? input.calls.controls.waitForControl : input.calls.live.getTurn).mockRejectedValueOnce(cause);
    const result = await createWhatsAppCallSendCommand(input).execute({command: "whatsapp.call.send", input: {text: "Done.", ...(operation === "turn" ? {voiceTurnId: "11111111-1111-4111-8111-111111111111"} : {})}, scope}).catch((error: unknown) => error as CommandStructuredError);
    expect(result).toMatchObject({cause, pandaCommandErrorCode: "command_failed", pandaCommandErrorDetails: {failureCode: "voice_state_unavailable", retryable: false}});
    expect(JSON.stringify((result as CommandStructuredError).toCommandError())).not.toContain("private-");
    if (operation === "wait") expect(result).toMatchObject({pandaCommandErrorDetails: {controlId: "control-1"}});
    if (operation === "turn") expect(input.enqueueControl).not.toHaveBeenCalled();
  });

  it("keeps deadline and cancellation outcomes distinct from store failures", async () => {
    const input = services();
    const command = createWhatsAppCallSendCommand(input);
    const request = {command: "whatsapp.call.send", input: {text: "Done."}, scope};
    vi.mocked(input.calls.controls.waitForControl).mockRejectedValueOnce(new VoiceControlWaitTimeoutError("deadline reached"));
    await expect(command.execute(request)).rejects.toMatchObject({pandaCommandErrorDetails: {failureCode: "timeout", retryable: true, controlId: "control-1"}});

    const controller = new AbortController();
    controller.abort();
    vi.mocked(input.calls.controls.waitForControl).mockRejectedValueOnce(controller.signal.reason);
    await expect(command.execute({...request, signal: controller.signal})).rejects.toMatchObject({message: "WhatsApp call command was cancelled.", pandaCommandErrorDetails: {failureCode: "worker_unavailable", controlId: "control-1"}});

    vi.mocked(input.calls.controls.waitForControl).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(command.execute({...request, signal: controller.signal})).rejects.toMatchObject({pandaCommandErrorDetails: {failureCode: "voice_state_unavailable"}});
  });
  it("reports owned active calls even when the deployment gate is disabled", async () => {
    const input = services(); input.env.PANDA_LIVE_VOICE_ENABLED = "false";
    const result = await createWhatsAppCallStatusCommand(input).execute({command: "whatsapp.call.status", input: {}, scope: {agentKey: "panda", sessionId: "session-1"}});
    expect(result.output).toMatchObject({ok: true, enabled: false, sessions: [{callId: "wacid.test", voice: "cove"}]});
  });

  it("queues an idempotent final delivery for the uniquely owned call", async () => {
    const input = services();
    const result = await createWhatsAppCallSendCommand(input).execute({command: "whatsapp.call.send", input: {text: "Done.", mode: "final"}, scope: {agentKey: "panda", sessionId: "session-1", parentToolCallId: "tool-1"}});
    expect(result.output).toEqual({ok: true, state: "sent"});
    expect(input.enqueueControl).toHaveBeenCalledWith(expect.objectContaining({connectorKey: "connector-1", operation: "send", callId: "wacid.test", text: "Done.", mode: "final", idempotencyKey: expect.stringMatching(/^whatsapp_call:/)}));
  });

  it("does not expose another agent's connector through a shared session binding", async () => {
    const input = services();
    input.connectorAccounts.listAccounts = vi.fn(async () => [{id: "a", source: "whatsapp", accountKey: "main", connectorKey: "connector-1", ownerKind: "agent", ownerIdentityId: null, ownerAgentKey: "other", status: "enabled", config: {mode: "meta_cloud", calling: {enabled: true, phoneNumberId: "1", wabaId: "2", graphVersion: "v23.0"}}, createdAt: 1, updatedAt: 1}]);
    await expect(createWhatsAppCallStatusCommand(input).execute({command: "whatsapp.call.status", input: {}, scope: {agentKey: "panda", sessionId: "session-1"}})).rejects.toMatchObject({pandaCommandErrorDetails: {failureCode: "resource_scope_denied"}});
  });

  it("ignores a bound Baileys account when inferring the call connector", async () => {
    const input = services();
    const cloud = (await input.connectorAccounts.listAccounts())[0]!;
    input.connectorAccounts.listAccounts = vi.fn(async () => [
      {...cloud, id: "baileys", connectorKey: "messages", config: {}},
      cloud,
    ]);
    const result = await createWhatsAppCallStatusCommand(input).execute({command: "whatsapp.call.status", input: {}, scope: {agentKey: "panda", sessionId: "session-1"}});
    expect(result.output).toMatchObject({sessions: [{callId: "wacid.test"}]});
  });
});
