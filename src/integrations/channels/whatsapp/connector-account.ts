import {randomUUID} from "node:crypto";

import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import {normalizeAgentKey} from "../../../domain/agents/types.js";
import {normalizeConnectorAccountKey} from "../../../domain/connectors/types.js";
import {trimToUndefined} from "../../../lib/strings.js";
import type {PostgresWhatsAppAuthStore} from "./auth-store.js";
import {WHATSAPP_SOURCE} from "./config.js";

export async function createWhatsAppConnectorAccount(input: {
  accountKey: string;
  agentKey: string;
  displayName?: string;
  accounts: Pick<PostgresConnectorAccountStore, "getAccountByKey" | "upsertAccount">;
}): Promise<ConnectorAccountRecord> {
  const accountKey = normalizeConnectorAccountKey(input.accountKey);
  const agentKey = normalizeAgentKey(input.agentKey);
  if (await input.accounts.getAccountByKey(WHATSAPP_SOURCE, accountKey)) {
    throw new Error(`WhatsApp account ${accountKey} already exists.`);
  }
  const id = randomUUID();
  return input.accounts.upsertAccount({
    id,
    source: WHATSAPP_SOURCE,
    accountKey,
    connectorKey: id,
    ownerKind: "agent",
    ownerAgentKey: agentKey,
    status: "disabled",
    ...(trimToUndefined(input.displayName) ? {displayName: input.displayName!.trim()} : {}),
  });
}

export async function requireWhatsAppConnectorAccount(input: {
  accountKey: string;
  ownerAgentKey?: string;
  accounts: Pick<PostgresConnectorAccountStore, "getAccountByKey">;
}): Promise<ConnectorAccountRecord> {
  const accountKey = normalizeConnectorAccountKey(input.accountKey);
  const account = await input.accounts.getAccountByKey(WHATSAPP_SOURCE, accountKey);
  if (!account || account.ownerKind !== "agent" || !account.ownerAgentKey) {
    throw new Error(`WhatsApp account ${accountKey} was not found.`);
  }
  if (input.ownerAgentKey && account.ownerAgentKey !== normalizeAgentKey(input.ownerAgentKey)) {
    throw new Error(`WhatsApp account ${accountKey} is not owned by agent ${input.ownerAgentKey}.`);
  }
  return account;
}

export async function resetWhatsAppConnectorAccount(input: {
  account: ConnectorAccountRecord;
  accounts: Pick<PostgresConnectorAccountStore, "clearAccountExternalIdentity">;
  auth: Pick<PostgresWhatsAppAuthStore, "deleteAuthState">;
}): Promise<ConnectorAccountRecord> {
  if (input.account.status !== "disabled" && input.account.status !== "error") {
    throw new Error(`Disable WhatsApp account ${input.account.accountKey} before resetting its link.`);
  }
  await input.auth.deleteAuthState(input.account.id);
  return input.accounts.clearAccountExternalIdentity(WHATSAPP_SOURCE, input.account.accountKey);
}
