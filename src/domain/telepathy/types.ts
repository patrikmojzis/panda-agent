export interface TelepathyDeviceRecord {
  agentKey: string;
  deviceId: string;
  label?: string;
  tokenHash: string;
  enabled: boolean;
  connected: boolean;
  createdAt: number;
  updatedAt: number;
  connectedAt?: number;
  lastSeenAt?: number;
  lastDisconnectedAt?: number;
  disabledAt?: number;
}

export interface RegisterTelepathyDeviceInput {
  agentKey: string;
  deviceId: string;
  tokenHash: string;
  label?: string;
}

export function normalizeTelepathyDeviceId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Device id must not be empty.");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(trimmed)) {
    throw new Error("Device id may only contain letters, numbers, dot, underscore, colon, and dash.");
  }

  return trimmed;
}

export function normalizeTelepathyLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}
