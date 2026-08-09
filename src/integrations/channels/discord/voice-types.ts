import type {JsonObject} from "../../../lib/json.js";
import {OPENAI_LIVE_MODEL} from "../../providers/openai-live/types.js";
import type {DiscordVoiceHealthReason, DiscordVoiceOperationalState} from "./voice-health.js";

export const DISCORD_VOICE_MODEL = OPENAI_LIVE_MODEL;

export type DiscordVoiceControlOperation = "join" | "leave" | "send";
export type DiscordVoiceSendMode = "progress" | "final";
export type DiscordVoiceControlStatus = "pending" | "running" | "completed" | "failed";
export type DiscordVoiceSessionState = "connecting" | "connected" | "disconnected" | "error";
export type DiscordVoiceTurnStatus = "pending" | "queued" | "running" | "awaiting_final" | "final_sending" | "completed" | "failed";

export interface DiscordVoiceControlInput {
  connectorKey: string;
  operation: DiscordVoiceControlOperation;
  sessionId: string;
  agentKey: string;
  channelId?: string;
  text?: string;
  mode?: DiscordVoiceSendMode;
  voiceTurnId?: string;
  idempotencyKey?: string;
}

export interface DiscordVoiceControlRecord extends DiscordVoiceControlInput {
  id: string;
  status: DiscordVoiceControlStatus;
  result?: JsonObject;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DiscordVoiceSessionRecord {
  connectorKey: string;
  guildId: string;
  channelId: string;
  sessionId: string;
  agentKey: string;
  voiceSessionId: string;
  state: DiscordVoiceSessionState;
  model: typeof DISCORD_VOICE_MODEL;
  lastError?: string;
  health?: DiscordVoiceOperationalState;
  healthReasons: readonly DiscordVoiceHealthReason[];
  healthObservedAt?: number;
  diagnostics?: JsonObject;
  startedAt: number;
  updatedAt: number;
}

export interface DiscordVoiceTurnInput {
  id: string;
  voiceSessionId: string;
  delegationId: string;
  connectorKey: string;
  guildId: string;
  channelId: string;
  sessionId: string;
  agentKey: string;
  externalActorId?: string;
  identityId?: string;
  sourceUtteranceId: string;
  prompt: string;
}

export interface DiscordVoiceTurnRecord extends DiscordVoiceTurnInput {
  status: DiscordVoiceTurnStatus;
  threadId?: string;
  runId?: string;
  resultText?: string;
  finalControlId?: string;
  finalText?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DiscordVoiceControlNotification {
  kind: "control";
  connectorKey: string;
  controlId: string;
}

export type DiscordVoiceNotification = DiscordVoiceControlNotification;
