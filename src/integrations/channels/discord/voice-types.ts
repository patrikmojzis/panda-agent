import type {JsonObject} from "../../../lib/json.js";
import {OPENAI_LIVE_MODEL} from "../../providers/openai-live/types.js";

export const DISCORD_VOICE_MODEL = OPENAI_LIVE_MODEL;

export type DiscordVoiceControlOperation = "join" | "leave" | "send";
export type DiscordVoiceSendMode = "progress" | "final";
export type DiscordVoiceControlStatus = "pending" | "running" | "completed" | "failed";

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

export interface DiscordVoiceControlNotification {
  kind: "control";
  connectorKey: string;
  controlId: string;
}

export type DiscordVoiceNotification = DiscordVoiceControlNotification;
