import type {IdentityStore} from "../../../domain/identity/store.js";
import {submitCurrentSessionInput} from "../../../domain/sessions/current-thread.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {DiscordVoiceDelegationRequestPayload} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator, ThreadRuntimeEvent} from "../../../domain/threads/runtime/coordinator.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {isRecord} from "../../../lib/records.js";
import {renderDiscordVoiceDelegation} from "../../../prompts/channels/discord-voice.js";
import type {DiscordVoiceStore} from "./voice-postgres.js";

export async function handleDiscordVoiceDelegationRequest(
  payload: DiscordVoiceDelegationRequestPayload,
  options: {
    voice: DiscordVoiceStore;
    coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
    sessions: Pick<SessionStore, "getSession">;
    identityStore: Pick<IdentityStore, "resolveIdentityBinding">;
  },
): Promise<Record<string, unknown>> {
  const turn = await options.voice.getTurn(payload.voiceTurnId);
  if (turn.status !== "pending") return {status: "skipped", reason: "turn_already_claimed", voiceTurnId: turn.id};
  try {
    const session = await options.sessions.getSession(turn.sessionId);
    if (session.agentKey !== turn.agentKey) {
      await options.voice.failTurn(turn.id, "session_agent_mismatch");
      return {status: "dropped", reason: "session_agent_mismatch"};
    }
    const binding = turn.externalActorId ? await options.identityStore.resolveIdentityBinding({source: "discord", connectorKey: turn.connectorKey, externalActorId: turn.externalActorId}) : undefined;
    const identityId = binding?.identityId ?? turn.identityId;
    const target = await submitCurrentSessionInput({
      sessions: options.sessions,
      sessionId: turn.sessionId,
      coordinator: options.coordinator,
      payload: {
        source: "discord",
        channelId: turn.channelId,
        externalMessageId: turn.id,
        ...(turn.externalActorId ? {actorId: turn.externalActorId} : {}),
        ...(identityId ? {identityId} : {}),
        message: stringToUserMessage(renderDiscordVoiceDelegation({prompt: turn.prompt, connectorKey: turn.connectorKey, guildId: turn.guildId, channelId: turn.channelId, voiceTurnId: turn.id, speakerId: turn.externalActorId})),
        metadata: {
          discordVoice: {
            connectorKey: turn.connectorKey,
            guildId: turn.guildId,
            channelId: turn.channelId,
            speakerId: turn.externalActorId ?? null,
            identityId: identityId ?? null,
            voiceSessionId: turn.voiceSessionId,
            voiceTurnId: turn.id,
          },
        },
      },
    });
    await options.voice.markTurnQueued(turn.id, target.threadId);
    return {status: "queued", threadId: target.threadId, voiceTurnId: turn.id};
  } catch (error) {
    await options.voice.failTurn(turn.id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  }
}

function voiceTurnId(message: {metadata?: unknown}): string | undefined {
  if (!isRecord(message.metadata) || !isRecord(message.metadata.discordVoice)) return undefined;
  const value = message.metadata.discordVoice.voiceTurnId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function createDiscordVoiceRuntimeEventHandler(options: {
  getVoiceStore(): DiscordVoiceStore | undefined;
}): (event: ThreadRuntimeEvent) => Promise<void> {
  return async (event) => {
    const voice = options.getVoiceStore();
    if (!voice) return;
    if (event.type === "inputs_applied") {
      const turnIds = event.messages.map(voiceTurnId).filter((value): value is string => Boolean(value));
      await voice.assignTurnsToRun(turnIds, event.runId);
      return;
    }
    if (event.type !== "run_finished") return;
    const turns = await voice.listRunningTurns(event.run.id);
    const error = event.run.status === "completed"
      ? "Panda completed without sending final Discord voice context."
      : event.run.error ?? "Panda voice delegation failed.";
    await Promise.all(turns.map((turn) => voice.failTurn(turn.id, error)));
  };
}
