import type {ConnectorAccountOwnerInput, ConnectorAccountRecord, UpsertConnectorAccountInput} from "../../../domain/connectors/types.js";
import type {CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {DISCORD_BOT_TOKEN_SECRET_KEY, DISCORD_SOURCE} from "./config.js";
import {type DiscordCurrentUser, type DiscordRestClient, requireDiscordBotToken} from "./api.js";

export interface DiscordAccountStore {
  upsertAccount(input: UpsertConnectorAccountInput): Promise<ConnectorAccountRecord>;
  getAccountByKey(source: string, accountKey: string): Promise<ConnectorAccountRecord | null>;
  disableAccount(source: string, accountKey: string): Promise<ConnectorAccountRecord>;
  setSecret(
    accountId: string,
    secretKey: string,
    plaintext: string,
    crypto: CredentialCrypto | null | undefined,
  ): Promise<unknown>;
  getSecret(
    accountId: string,
    secretKey: string,
    crypto: CredentialCrypto | null | undefined,
  ): Promise<string | null>;
}

export interface SetDiscordBotAccountInput extends ConnectorAccountOwnerInput {
  accountKey: string;
  botToken: string;
  client: DiscordRestClient;
  crypto: CredentialCrypto | null | undefined;
  store: DiscordAccountStore;
}

export interface StoredDiscordBotAccountInput {
  accountKey: string;
  client: DiscordRestClient;
  crypto: CredentialCrypto | null | undefined;
  store: DiscordAccountStore;
}

export interface DisableDiscordBotAccountInput {
  accountKey: string;
  store: Pick<DiscordAccountStore, "disableAccount">;
}

export interface DiscordBotAccountResult {
  account: ConnectorAccountRecord;
  botUser: DiscordCurrentUser;
}


function buildSecretRedactionFragments(secret: string): readonly string[] {
  const exact = secret.trim();
  if (!exact) {
    return [];
  }

  const pieces = exact
    .split(/[^A-Za-z0-9]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 8);
  return [...new Set([exact, ...pieces])];
}

function sanitizeSecretError(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const fragment of buildSecretRedactionFragments(secret)) {
    sanitized = sanitized.split(fragment).join("[redacted]");
  }

  if (error instanceof Error && sanitized === message) {
    return error;
  }

  return new Error(sanitized);
}

async function withSecretErrorSafety<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw sanitizeSecretError(error, secret);
  }
}

function requireDiscordAccountCrypto(crypto: CredentialCrypto | null | undefined): CredentialCrypto {
  if (!crypto) {
    throw new Error("CREDENTIALS_MASTER_KEY is required for Discord account commands.");
  }

  return crypto;
}

function buildDiscordAccountInput(
  input: SetDiscordBotAccountInput,
  botUser: DiscordCurrentUser,
): UpsertConnectorAccountInput {
  return {
    source: DISCORD_SOURCE,
    accountKey: input.accountKey,
    connectorKey: botUser.id,
    ownerKind: input.ownerKind,
    ownerIdentityId: input.ownerIdentityId,
    ownerAgentKey: input.ownerAgentKey,
    displayName: botUser.displayName,
    externalAccountId: botUser.id,
    externalUsername: botUser.username,
    status: "enabled",
  };
}

export async function setDiscordBotAccount(input: SetDiscordBotAccountInput): Promise<DiscordBotAccountResult> {
  const crypto = requireDiscordAccountCrypto(input.crypto);
  const botToken = requireDiscordBotToken(input.botToken);
  const botUser = await withSecretErrorSafety(botToken, () => input.client.getCurrentUser(botToken));
  const account = await input.store.upsertAccount(buildDiscordAccountInput(input, botUser));
  await withSecretErrorSafety(botToken, () => (
    input.store.setSecret(account.id, DISCORD_BOT_TOKEN_SECRET_KEY, botToken, crypto)
  ));

  return {account, botUser};
}

export async function validateStoredDiscordBotAccount(
  input: StoredDiscordBotAccountInput,
): Promise<DiscordBotAccountResult> {
  const crypto = requireDiscordAccountCrypto(input.crypto);
  const account = await input.store.getAccountByKey(DISCORD_SOURCE, input.accountKey);
  if (!account) {
    throw new Error(`Unknown Discord account ${input.accountKey}.`);
  }

  const botToken = await input.store.getSecret(account.id, DISCORD_BOT_TOKEN_SECRET_KEY, crypto);
  if (!botToken) {
    throw new Error(`Discord account ${input.accountKey} does not have a stored bot token.`);
  }

  const botUser = await withSecretErrorSafety(botToken, () => input.client.getCurrentUser(botToken));
  if (botUser.id !== account.connectorKey) {
    throw new Error("Stored Discord token identity does not match the connector account.");
  }

  return {account, botUser};
}

export async function disableDiscordBotAccount(
  input: DisableDiscordBotAccountInput,
): Promise<{account: ConnectorAccountRecord}> {
  const account = await input.store.disableAccount(DISCORD_SOURCE, input.accountKey);
  return {account};
}
