import type {ThinkingLevel} from "@mariozechner/pi-ai";

import type {JsonObject} from "../../kernel/agent/types.js";
import {normalizeAgentKey} from "../agents/types.js";

export const SIDECAR_INPUT_SOURCE = "sidecar";
export const SIDECAR_EVENT_SOURCE = "sidecar_event";
export const SIDECAR_SESSION_BINDING_KIND = "sidecar";

export const SIDECAR_TRIGGERS = [
  "before_run_step",
  "after_assistant",
  "after_tool_result",
  "after_run_finish",
] as const;

export type SidecarTrigger = typeof SIDECAR_TRIGGERS[number];
export type SidecarToolset = "readonly";

export interface SidecarDefinitionRecord {
  agentKey: string;
  sidecarKey: string;
  displayName: string;
  enabled: boolean;
  prompt: string;
  triggers: readonly SidecarTrigger[];
  model?: string;
  thinking?: ThinkingLevel;
  toolset: SidecarToolset;
  metadata?: JsonObject;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSidecarDefinitionInput {
  agentKey: string;
  sidecarKey: string;
  displayName?: string;
  enabled?: boolean;
  prompt: string;
  triggers: readonly SidecarTrigger[];
  model?: string | null;
  thinking?: ThinkingLevel | null;
  toolset?: SidecarToolset;
  metadata?: JsonObject | null;
}

export function normalizeSidecarKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Sidecar key must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error("Sidecar key must start with a letter or number and use only lowercase letters, numbers, hyphen, or underscore, max 32 chars.");
  }

  return normalized;
}

export function normalizeSidecarPrompt(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Sidecar prompt must not be empty.");
  }

  return normalized;
}

export function normalizeSidecarTrigger(value: string): SidecarTrigger {
  const normalized = value.trim();
  if ((SIDECAR_TRIGGERS as readonly string[]).includes(normalized)) {
    return normalized as SidecarTrigger;
  }

  throw new Error(`Unknown sidecar trigger ${value}. Use one of: ${SIDECAR_TRIGGERS.join(", ")}.`);
}

export function normalizeSidecarTriggers(values: readonly string[]): readonly SidecarTrigger[] {
  const normalized = [...new Set(values.map(normalizeSidecarTrigger))];
  if (normalized.length === 0) {
    throw new Error("Sidecar needs at least one trigger.");
  }

  return normalized;
}

export function normalizeSidecarAgentKey(value: string): string {
  return normalizeAgentKey(value);
}
