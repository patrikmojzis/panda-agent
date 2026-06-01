import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildConnectorAccountTableNames} from "../connectors/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const DEFAULT_CONNECTOR_ACCOUNTS_LIMIT = 50;
const MAX_CONNECTOR_ACCOUNTS_LIMIT = 100;

type OwnerKind = "system" | "identity" | "agent";

type AccountRow = {
  id: string;
  source: string;
  account_key: string;
  connector_key: string;
  display_name: string | null;
  external_account_id: string | null;
  external_username: string | null;
  status: string;
  owner_kind: OwnerKind;
  owner_agent_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type SecretRow = {
  account_id: string;
  secret_key: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ControlConnectorAccountSecretKey = {
  secretKey: string;
  createdAt: string;
  updatedAt: string;
};

export type ControlConnectorAccount = {
  id: string;
  source: string;
  accountKey: string;
  connectorKey: string;
  displayName?: string;
  externalAccountId?: string;
  externalUsername?: string;
  status: string;
  ownerKind: OwnerKind;
  ownerAgentKey?: string;
  createdAt: string;
  updatedAt: string;
  secretKeys: ControlConnectorAccountSecretKey[];
};

export type ControlConnectorAccountsSummary = {
  total: number;
  agentOwned: number;
  systemOwned: number;
};

export type ControlConnectorAccountsRecord = {
  agentKey: string;
  summary: ControlConnectorAccountsSummary;
  accounts: ControlConnectorAccount[];
};

export type GetConnectorAccountsInput = {
  limit?: number;
};

function parseLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONNECTOR_ACCOUNTS_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new Error("Control connector accounts limit must be a positive integer.");
  return Math.min(MAX_CONNECTOR_ACCOUNTS_LIMIT, value);
}

function isoDate(value: Date | string): string {
  return new Date(value).toISOString();
}

function publicAccount(row: AccountRow, secretKeys: readonly ControlConnectorAccountSecretKey[]): ControlConnectorAccount {
  return {
    id: String(row.id),
    source: String(row.source),
    accountKey: String(row.account_key),
    connectorKey: String(row.connector_key),
    ...(typeof row.display_name === "string" ? {displayName: row.display_name} : {}),
    ...(typeof row.external_account_id === "string" ? {externalAccountId: row.external_account_id} : {}),
    ...(typeof row.external_username === "string" ? {externalUsername: row.external_username} : {}),
    status: String(row.status),
    ownerKind: row.owner_kind,
    ...(row.owner_kind === "agent" && typeof row.owner_agent_key === "string" ? {ownerAgentKey: row.owner_agent_key} : {}),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    secretKeys: [...secretKeys],
  };
}

export class ControlConnectorAccountsService {
  private readonly pool: PgQueryable;
  private readonly agents = buildAgentTableNames();
  private readonly control = buildControlTableNames();
  private readonly connectors = buildConnectorAccountTableNames();

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const result = await this.pool.query(`
      SELECT agent.agent_key
      FROM ${this.agents.agents} AS agent
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND grant_row.role = $2
       AND (grant_row.role = 'admin' OR grant_row.agent_key = agent.agent_key)
      LEFT JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = agent.agent_key
       AND pairing.identity_id = $1
      WHERE agent.agent_key = $3
        AND agent.status = 'active'
        AND (grant_row.role = 'admin' OR pairing.identity_id IS NOT NULL)
      LIMIT 1
    `, [session.identityId, session.role, normalizedAgentKey]);
    if (result.rows.length === 0) {
      throw new Error("Control connector accounts target agent was not found or is not visible.");
    }
  }

  async getConnectorAccounts(session: ControlSessionRecord, agentKey: string, input: GetConnectorAccountsInput = {}): Promise<ControlConnectorAccountsRecord> {
    const limit = parseLimit(input.limit);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    await this.assertCanAccess(session, normalizedAgentKey);

    const accountResult = await this.pool.query(`
      SELECT
        id::text AS id,
        source,
        account_key,
        connector_key,
        display_name,
        external_account_id,
        external_username,
        status,
        owner_kind,
        owner_agent_key,
        created_at,
        updated_at
      FROM ${this.connectors.connectorAccounts}
      WHERE owner_kind = 'agent'
        AND owner_agent_key = $1
        ${session.role === "admin" ? "OR owner_kind = 'system'" : ""}
      ORDER BY owner_kind ASC, source ASC, account_key ASC, id ASC
      LIMIT $2
    `, [normalizedAgentKey, limit]);
    const accountRows = accountResult.rows as AccountRow[];
    const accountIds = accountRows.map((row) => String(row.id));
    const secretKeysByAccountId = new Map<string, ControlConnectorAccountSecretKey[]>();

    if (accountIds.length > 0) {
      const placeholders = accountIds.map((_, index) => `$${index + 1}`).join(", ");
      const secretResult = await this.pool.query(`
        SELECT account_id::text AS account_id, secret_key, created_at, updated_at
        FROM ${this.connectors.connectorAccountSecrets}
        WHERE account_id IN (${placeholders})
        ORDER BY account_id ASC, secret_key ASC
      `, accountIds);
      for (const raw of secretResult.rows as SecretRow[]) {
        const accountId = String(raw.account_id);
        const list = secretKeysByAccountId.get(accountId) ?? [];
        list.push({
          secretKey: String(raw.secret_key),
          createdAt: isoDate(raw.created_at),
          updatedAt: isoDate(raw.updated_at),
        });
        secretKeysByAccountId.set(accountId, list);
      }
    }

    const accounts = accountRows.map((row) => publicAccount(row, secretKeysByAccountId.get(String(row.id)) ?? []));
    return {
      agentKey: normalizedAgentKey,
      summary: {
        total: accounts.length,
        agentOwned: accounts.filter((account) => account.ownerKind === "agent").length,
        systemOwned: accounts.filter((account) => account.ownerKind === "system").length,
      },
      accounts,
    };
  }
}
