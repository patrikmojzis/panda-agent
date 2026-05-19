import type {JsonObject, JsonValue} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import {normalizeAgentKey} from "../agents/types.js";

export type ConnectorAccountStatus = "enabled" | "disabled" | "revoked" | "error";
export type ConnectorAccountOwnerKind = "system" | "identity" | "agent";

export interface ConnectorAccountOwnerInput {
  ownerKind?: ConnectorAccountOwnerKind;
  ownerIdentityId?: string;
  ownerAgentKey?: string;
}

export interface NormalizedConnectorAccountOwner {
  ownerKind: ConnectorAccountOwnerKind;
  ownerIdentityId: string | null;
  ownerAgentKey: string | null;
}

export interface ConnectorAccountRecord extends NormalizedConnectorAccountOwner {
  id: string;
  source: string;
  accountKey: string;
  connectorKey: string;
  displayName?: string;
  externalAccountId?: string;
  externalUsername?: string;
  status: ConnectorAccountStatus;
  config: JsonObject;
  metadata?: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertConnectorAccountInput extends ConnectorAccountOwnerInput {
  id?: string;
  source: string;
  accountKey: string;
  connectorKey: string;
  displayName?: string;
  externalAccountId?: string;
  externalUsername?: string;
  status?: ConnectorAccountStatus;
  config?: JsonObject;
  metadata?: JsonValue;
}

export interface ConnectorAccountListFilter {
  source?: string;
  status?: ConnectorAccountStatus;
  ownerKind?: ConnectorAccountOwnerKind;
}

export interface ConnectorAccountSecretSummary {
  accountId: string;
  secretKey: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizeConnectorSource(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("Connector source must use 1-64 lowercase letters, numbers, dashes, or underscores, starting with a letter.");
  }

  return normalized;
}

export function normalizeConnectorAccountKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Connector account key must not be empty.");
  }
  if (trimmed.length > 128) {
    throw new Error("Connector account key must be at most 128 characters.");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error("Connector account key must not contain control characters.");
  }

  return trimmed;
}

export function normalizeConnectorKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Connector key must not be empty.");
  }
  if (trimmed.length > 256) {
    throw new Error("Connector key must be at most 256 characters.");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error("Connector key must not contain control characters.");
  }

  return trimmed;
}

export function normalizeConnectorSecretKey(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(trimmed)) {
    throw new Error("Connector secret key must use 1-128 letters, numbers, dashes, underscores, dots, or colons.");
  }

  return trimmed;
}

export function normalizeConnectorAccountStatus(value: ConnectorAccountStatus): ConnectorAccountStatus {
  if (value === "enabled" || value === "disabled" || value === "revoked" || value === "error") {
    return value;
  }

  throw new Error(`Unsupported connector account status ${String(value)}.`);
}

export function normalizeConnectorOwnerKind(value: ConnectorAccountOwnerKind): ConnectorAccountOwnerKind {
  if (value === "system" || value === "identity" || value === "agent") {
    return value;
  }

  throw new Error(`Unsupported connector account owner kind ${String(value)}.`);
}

export function normalizeConnectorOwnerInput(
  input: ConnectorAccountOwnerInput = {},
): NormalizedConnectorAccountOwner {
  const ownerIdentityId = trimToUndefined(input.ownerIdentityId) ?? null;
  const ownerAgentKey = trimToUndefined(input.ownerAgentKey) ?? null;
  if (ownerIdentityId && ownerAgentKey) {
    throw new Error("Connector account owner must be exclusive: choose identity or agent, not both.");
  }

  const ownerKind = input.ownerKind === undefined
    ? ownerIdentityId ? "identity" : ownerAgentKey ? "agent" : "system"
    : normalizeConnectorOwnerKind(input.ownerKind);

  if (ownerKind === "system") {
    if (ownerIdentityId || ownerAgentKey) {
      throw new Error("System-owned connector accounts must not include identity or agent owners.");
    }

    return {
      ownerKind,
      ownerIdentityId: null,
      ownerAgentKey: null,
    };
  }

  if (ownerKind === "identity") {
    if (!ownerIdentityId || ownerAgentKey) {
      throw new Error("Identity-owned connector accounts require only ownerIdentityId.");
    }

    return {
      ownerKind,
      ownerIdentityId,
      ownerAgentKey: null,
    };
  }

  if (!ownerAgentKey || ownerIdentityId) {
    throw new Error("Agent-owned connector accounts require only ownerAgentKey.");
  }

  return {
    ownerKind,
    ownerIdentityId: null,
    ownerAgentKey: normalizeAgentKey(ownerAgentKey),
  };
}
