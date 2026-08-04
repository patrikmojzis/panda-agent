import type {JsonObject} from "../../../lib/json.js";
import {OPENAI_LIVE_MODEL} from "../../providers/openai-live/types.js";

export const DISCORD_VOICE_MODEL = OPENAI_LIVE_MODEL;

export type DiscordVoiceControlOperation = "join" | "leave" | "send";
export type DiscordVoiceSendMode = "progress" | "final";
export type DiscordVoiceControlStatus = "pending" | "running" | "completed" | "failed";
export type DiscordVoiceSessionState = "connecting" | "connected" | "disconnected" | "error";
export type DiscordVoiceTurnStatus = "pending" | "queued" | "running" | "completed" | "failed";

export interface DiscordVoiceControlInput {
  connectorKey: string;
  operation: DiscordVoiceControlOperation;
  sessionId: string;
  agentKey: string;
  channelId?: string;
  text?: string;
  mode?: DiscordVoiceSendMode;
  voiceTurnId?: string;
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
  prompt: string;
}

export interface DiscordVoiceTurnRecord extends DiscordVoiceTurnInput {
  status: DiscordVoiceTurnStatus;
  threadId?: string;
  runId?: string;
  resultText?: string;
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
