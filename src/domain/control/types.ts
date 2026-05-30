export type ControlGrantRole = "admin" | "scoped";

export interface ControlGrantRecord {
  id: string;
  identityId: string;
  role: ControlGrantRole;
  agentKey?: string;
  label?: string;
  active: boolean;
  loginTokenExpiresAt: number;
  loginTokenConsumedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ControlSessionRecord {
  id: string;
  identityId: string;
  role: ControlGrantRole;
  csrfTokenHash: string;
  expiresAt: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface ControlLoginResult {
  session: ControlSessionRecord;
  sessionToken: string;
  csrfToken: string;
}
