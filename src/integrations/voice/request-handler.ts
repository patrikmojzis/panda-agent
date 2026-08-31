import type {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import type {LiveVoiceSessionRecord, LiveVoiceTurnRecord} from "../../domain/live-voice/types.js";
import type {LiveVoiceDelegationRequestPayload} from "../../domain/threads/requests/types.js";
import {RetryableRuntimeRequestError} from "../../domain/threads/requests/errors.js";
import type {ThreadRuntimeCoordinator, ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadEnqueueOptions} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
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
    coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
    enqueueOptions: ThreadEnqueueOptions & {inputId: string};
    store: Pick<ThreadRuntimeStore, "findInput" | "getThread">;
    sessions: Pick<SessionStore, "getSession">;
    identityStore: Pick<IdentityStore, "resolveIdentityBinding">;
    authorizeTurn?(input: LiveVoiceDelegationRenderInput): Promise<boolean>;
    renderDelegation(input: LiveVoiceDelegationRenderInput): string;
  },
): Promise<Record<string, unknown>> {
  const turn = await options.voice.getTurn(payload.liveVoiceTurnId);
  if (turn.status !== "pending") return {status: "skipped", reason: "turn_already_claimed", liveVoiceTurnId: turn.id};
  let liveSession: LiveVoiceSessionRecord;
  let identityId: string | undefined;
  let renderedDelegation: string;
  try {
    liveSession = await options.voice.getSession(turn.liveVoiceSessionId);
    const session = await options.sessions.getSession(turn.sessionId);
    if (
      session.agentKey !== turn.agentKey
      || liveSession.sessionId !== turn.sessionId
      || liveSession.agentKey !== turn.agentKey
    ) {
      await options.voice.failTurn(turn.id, "session_agent_mismatch");
      return {status: "dropped", reason: "session_agent_mismatch"};
    }
    if (liveSession.state !== "connected") {
      await options.voice.failTurn(turn.id, "live_voice_session_closed");
      return {status: "dropped", reason: "live_voice_session_closed"};
    }
    if (options.authorizeTurn && !(await options.authorizeTurn({liveSession, turn}))) {
      await options.voice.failTurn(turn.id, "authorization_revoked");
      return {status: "dropped", reason: "authorization_revoked"};
    }
    const binding = turn.externalActorId
      ? await options.identityStore.resolveIdentityBinding({source: liveSession.source, connectorKey: liveSession.connectorKey, externalActorId: turn.externalActorId})
      : undefined;
    identityId = binding?.identityId ?? turn.identityId;
  } catch (error) {
    const deterministicMissing = error instanceof Error && (
      error.message === `Unknown live voice session ${turn.liveVoiceSessionId}.`
      || error.message === `Unknown session ${turn.sessionId}`
    );
    if (deterministicMissing) {
      await options.voice.failTurn(turn.id, error.message);
      throw error;
    }
    throw new RetryableRuntimeRequestError(
      `Live voice turn ${turn.id} setup could not be read.`,
      {cause: error},
    );
  }
  try {
    renderedDelegation = options.renderDelegation({liveSession, turn});
  } catch (error) {
    await options.voice.failTurn(turn.id, error instanceof Error ? error.message : String(error));
    throw error;
  }

  let target: {threadId: string};
  try {
    target = await submitCurrentSessionInput({
      sessionId: turn.sessionId,
      coordinator: options.coordinator,
      options: options.enqueueOptions,
      payload: {
        source: liveSession.source,
        channelId: liveSession.roomKey,
        externalMessageId: turn.id,
        ...(turn.externalActorId ? {actorId: turn.externalActorId} : {}),
        ...(identityId ? {identityId} : {}),
        message: stringToUserMessage(renderedDelegation),
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
  } catch (error) {
    let committedInput;
    try {
      committedInput = await options.store.findInput(options.enqueueOptions.inputId);
    } catch (probeError) {
      throw new RetryableRuntimeRequestError(
        `Live voice turn ${turn.id} enqueue outcome could not be reconciled.`,
        {cause: probeError},
      );
    }
    if (!committedInput) {
      await options.voice.failTurn(turn.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    let committedThread;
    try {
      committedThread = await options.store.getThread(committedInput.threadId);
    } catch (probeError) {
      throw new RetryableRuntimeRequestError(
        `Live voice turn ${turn.id} committed input target could not be reconciled.`,
        {cause: probeError},
      );
    }
    if (
      committedThread.sessionId !== turn.sessionId
      || committedInput.source !== liveSession.source
      || committedInput.channelId !== liveSession.roomKey
      || committedInput.externalMessageId !== turn.id
    ) {
      await options.voice.failTurn(turn.id, "delegation_input_conflict");
      throw new Error(`Live voice turn ${turn.id} input id is bound to another delegation.`);
    }
    target = {threadId: committedInput.threadId};
  }

  try {
    await options.voice.markTurnQueued(turn.id, target.threadId);
  } catch (error) {
    try {
      await options.voice.getTurn(turn.id);
    } catch (probeError) {
      throw new RetryableRuntimeRequestError(
        `Live voice turn ${turn.id} queued transition could not be reconciled.`,
        {cause: probeError},
      );
    }
    // The input ledger is authoritative. inputs_applied advances pending turns
    // directly to running, so a failed observational queued update is safe.
  }
  return {status: "queued", threadId: target.threadId, liveVoiceTurnId: turn.id};
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
