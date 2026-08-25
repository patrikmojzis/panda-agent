import {createHash} from "node:crypto";

import {buildAgentTableNames} from "../../../domain/agents/postgres-shared.js";
import {buildConnectorAccountTableNames} from "../../../domain/connectors/postgres-shared.js";
import {buildIdentityTableNames} from "../../../domain/identity/postgres-shared.js";
import type {WhatsAppAuthorizationSnapshot} from "../../../domain/threads/requests/types.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../../lib/strings.js";
import {WHATSAPP_SOURCE} from "./config.js";

export interface AuthorizedWhatsAppActor extends WhatsAppAuthorizationSnapshot {
  authorized: true;
  identityHandle: string;
}

export type WhatsAppActorAuthorization =
  | AuthorizedWhatsAppActor
  | {authorized: false; reason: "actor_not_authorized"};

export interface WhatsAppActorAuthorizer {
  authorizeActor(input: {
    connectorKey: string;
    externalActorId: string;
  }): Promise<WhatsAppActorAuthorization>;
}

function authorizationVersion(row: Record<string, unknown>): string {
  const versionParts = [
    "account_id",
    "account_version",
    "binding_id",
    "binding_version",
    "identity_id",
    "identity_version",
    "pairing_version",
    "agent_version",
  ].map((field) => requireNonEmptyString(row[field], `WhatsApp authorization row is missing ${field}.`));
  return createHash("sha256").update(JSON.stringify(versionParts)).digest("hex");
}

/** Reads one uncached database snapshot of every mutable WhatsApp authority row. */
export function createWhatsAppActorAuthorizer(input: {
  pool: PgQueryable;
}): WhatsAppActorAuthorizer {
  const accounts = buildConnectorAccountTableNames().connectorAccounts;
  const identities = buildIdentityTableNames();
  const agents = buildAgentTableNames();
  return {
    async authorizeActor(lookup) {
      const result = await input.pool.query(`
        SELECT
          account.id AS account_id,
          to_char(account.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS account_version,
          binding.id AS binding_id,
          to_char(binding.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS binding_version,
          identity.id AS identity_id,
          identity.handle AS identity_handle,
          to_char(identity.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS identity_version,
          account.owner_agent_key AS agent_key,
          to_char(pairing.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS pairing_version,
          to_char(agent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS agent_version
        FROM ${accounts} AS account
        INNER JOIN ${identities.identityBindings} AS binding
          ON binding.source = account.source
          AND binding.connector_key = account.connector_key
          AND binding.external_actor_id = $2
        INNER JOIN ${identities.identities} AS identity
          ON identity.id = binding.identity_id
          AND identity.status = 'active'
        INNER JOIN ${agents.agentPairings} AS pairing
          ON pairing.identity_id = identity.id
          AND pairing.agent_key = account.owner_agent_key
        INNER JOIN ${agents.agents} AS agent
          ON agent.agent_key = account.owner_agent_key
          AND agent.status = 'active'
        WHERE account.source = $1
          AND account.connector_key = $3
          AND account.owner_kind = 'agent'
          AND account.status = 'enabled'
        LIMIT 1
      `, [WHATSAPP_SOURCE, lookup.externalActorId, lookup.connectorKey]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return {authorized: false, reason: "actor_not_authorized"};

      return {
        authorized: true,
        identityId: requireNonEmptyString(row.identity_id, "WhatsApp authorization row is missing identity_id."),
        identityHandle: requireNonEmptyString(row.identity_handle, "WhatsApp authorization row is missing identity_handle."),
        agentKey: requireNonEmptyString(row.agent_key, "WhatsApp authorization row is missing agent_key."),
        actorBindingId: requireNonEmptyString(row.binding_id, "WhatsApp authorization row is missing binding_id."),
        authorizationVersion: authorizationVersion(row),
      };
    },
  };
}
