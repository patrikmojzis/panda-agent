import {randomUUID} from "node:crypto";

import type {AgentStore} from "../../domain/agents/store.js";
import type {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import type {LiveVoiceSessionInput} from "../../domain/live-voice/types.js";
import type {JsonObject} from "../../lib/json.js";
import {LiveVoiceCall, type LiveVoiceOutput} from "./live-call.js";
import type {LiveVoiceProviderDefinition} from "./provider.js";

export interface PrepareLiveVoiceCallInput {
  source: string;
  connectorKey: string;
  scopeKey: string;
  roomKey: string;
  sessionId: string;
  agentKey: string;
  transportContext?: JsonObject;
  instructions: string;
  provider: LiveVoiceProviderDefinition;
  resolvedVoice?: string;
  agents: Pick<AgentStore, "getAgent">;
  voice: LiveVoiceRepo;
  output: LiveVoiceOutput;
  log(event: string, payload: Record<string, unknown>): void;
  onStateChange?(): void;
  authorizeDelegation?(): Promise<boolean>;
  onTerminalFailure(reason: string): void;
}

export interface PreparedLiveVoiceCall {
  call: LiveVoiceCall;
  sessionRecord: LiveVoiceSessionInput;
  provider: LiveVoiceProviderDefinition;
  voice: string;
}

export async function resolveLiveVoiceSelection(input: {
  agentKey: string;
  agents: Pick<AgentStore, "getAgent">;
  provider: LiveVoiceProviderDefinition;
}): Promise<string> {
  const agent = await input.agents.getAgent(input.agentKey);
  if (agent.status !== "active") throw Object.assign(new Error(`Agent ${agent.agentKey} is not active.`), {code: "agent_unavailable"});
  return input.provider.validateVoice(agent.liveVoice);
}

/** Resolves one immutable agent/provider snapshot before a transport exposes media. */
export async function prepareLiveVoiceCall(input: PrepareLiveVoiceCallInput): Promise<PreparedLiveVoiceCall> {
  const voice = input.resolvedVoice === undefined
    ? await resolveLiveVoiceSelection(input)
    : input.provider.validateVoice(input.resolvedVoice);
  const sessionRecord: LiveVoiceSessionInput = {
    id: randomUUID(),
    source: input.source,
    connectorKey: input.connectorKey,
    scopeKey: input.scopeKey,
    roomKey: input.roomKey,
    sessionId: input.sessionId,
    agentKey: input.agentKey,
    provider: input.provider.id,
    model: input.provider.model,
    voice,
    state: "connecting",
    ...(input.transportContext ? {transportContext: input.transportContext} : {}),
  };
  await input.voice.upsertSession(sessionRecord);
  const call = new LiveVoiceCall({
    liveVoiceSessionId: sessionRecord.id,
    sessionId: input.sessionId,
    agentKey: input.agentKey,
    voice: input.voice,
    createProvider: input.provider.createSession,
    providerConfig: {voice, instructions: input.instructions},
    output: input.output,
    log: input.log,
    onStateChange: input.onStateChange,
    authorizeDelegation: input.authorizeDelegation,
    onTerminalFailure: input.onTerminalFailure,
  });
  return {call, sessionRecord, provider: input.provider, voice};
}
