import type {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import type {LiveVoiceSessionRecord, LiveVoiceTurnRecord} from "../../domain/live-voice/types.js";
import type {LiveVoiceDelegationRequestPayload} from "../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator, ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import {submitCurrentSessionInput} from "../../domain/sessions/current-thread.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {isRecord} from "../../lib/records.js";

export interface LiveVoiceDelegationRenderInput {
  liveSession: LiveVoiceSessionRecord;
  turn: LiveVoiceTurnRecord;
}

/** Hands a provider delegation to the durable Panda session at its current thread. */
export async function handleLiveVoiceDelegationRequest(
  payload: LiveVoiceDelegationRequestPayload,
  options: {
    voice: LiveVoiceRepo;
    coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
    sessions: Pick<SessionStore, "getSession">;
    identityStore: Pick<IdentityStore, "resolveIdentityBinding">;
    renderDelegation(input: LiveVoiceDelegationRenderInput): string;
  },
): Promise<Record<string, unknown>> {
  const turn = await options.voice.getTurn(payload.liveVoiceTurnId);
  if (turn.status !== "pending") return {status: "skipped", reason: "turn_already_claimed", liveVoiceTurnId: turn.id};
  try {
    const liveSession = await options.voice.getSession(turn.liveVoiceSessionId);
    const session = await options.sessions.getSession(turn.sessionId);
    if (session.agentKey !== turn.agentKey || liveSession.sessionId !== turn.sessionId || liveSession.agentKey !== turn.agentKey) {
      await options.voice.failTurn(turn.id, "session_agent_mismatch");
      return {status: "dropped", reason: "session_agent_mismatch"};
    }
    const binding = turn.externalActorId
      ? await options.identityStore.resolveIdentityBinding({source: liveSession.source, connectorKey: liveSession.connectorKey, externalActorId: turn.externalActorId})
      : undefined;
    const identityId = binding?.identityId ?? turn.identityId;
    const target = await submitCurrentSessionInput({
      sessions: options.sessions,
      sessionId: turn.sessionId,
      coordinator: options.coordinator,
      payload: {
        source: liveSession.source,
        channelId: liveSession.roomKey,
        externalMessageId: turn.id,
        ...(turn.externalActorId ? {actorId: turn.externalActorId} : {}),
        ...(identityId ? {identityId} : {}),
        message: stringToUserMessage(options.renderDelegation({liveSession, turn})),
        metadata: {
          liveVoice: {
            source: liveSession.source,
            connectorKey: liveSession.connectorKey,
            scopeKey: liveSession.scopeKey,
            roomKey: liveSession.roomKey,
            speakerId: turn.externalActorId ?? null,
            identityId: identityId ?? null,
            liveVoiceSessionId: liveSession.id,
            liveVoiceTurnId: turn.id,
          },
        },
      },
    });
    await options.voice.markTurnQueued(turn.id, target.threadId);
    return {status: "queued", threadId: target.threadId, liveVoiceTurnId: turn.id};
  } catch (error) {
    await options.voice.failTurn(turn.id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  }
}

function liveVoiceTurnId(message: {metadata?: unknown}): string | undefined {
  if (!isRecord(message.metadata) || !isRecord(message.metadata.liveVoice)) return undefined;
  const value = message.metadata.liveVoice.liveVoiceTurnId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function createLiveVoiceRuntimeEventHandler(options: {
  getVoiceRepo(): LiveVoiceRepo | undefined;
}): (event: ThreadRuntimeEvent) => Promise<void> {
  return async (event) => {
    const voice = options.getVoiceRepo();
    if (!voice) return;
    if (event.type === "inputs_applied") {
      const turnIds = event.messages.map(liveVoiceTurnId).filter((value): value is string => Boolean(value));
      await voice.assignTurnsToRun(turnIds, event.runId);
      return;
    }
    if (event.type !== "run_finished") return;
    const turns = await voice.listRunningTurns(event.run.id);
    if (event.run.status === "completed") {
      await voice.markTurnsAwaitingFinal(event.run.id);
      return;
    }
    const error = event.run.error ?? "Panda live voice delegation failed.";
    await Promise.all(turns.map((turn) => voice.failTurn(turn.id, error)));
  };
}
