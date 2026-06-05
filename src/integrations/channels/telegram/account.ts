import {Bot} from "grammy";

import type {ConnectorAccountOwnerInput, ConnectorAccountRecord, UpsertConnectorAccountInput} from "../../../domain/connectors/types.js";
import type {CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {TELEGRAM_BOT_TOKEN_SECRET_KEY, TELEGRAM_SOURCE, requireTelegramBotToken} from "./config.js";

export interface TelegramBotIdentity {
  id: string;
  username?: string;
  displayName?: string;
}

export interface TelegramBotIdentityClient {
  getBotIdentity(token: string): Promise<TelegramBotIdentity>;
}

export interface TelegramAccountStore {
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

export interface SetTelegramBotAccountInput extends ConnectorAccountOwnerInput {
  accountKey: string;
  botToken: string;
  client: TelegramBotIdentityClient;
  crypto: CredentialCrypto | null | undefined;
  store: TelegramAccountStore;
}

export interface StoredTelegramBotAccountInput {
  accountKey: string;
  client: TelegramBotIdentityClient;
  crypto: CredentialCrypto | null | undefined;
  store: TelegramAccountStore;
}

export interface DisableTelegramBotAccountInput {
  accountKey: string;
  store: Pick<TelegramAccountStore, "disableAccount">;
}

export interface TelegramBotAccountResult {
  account: ConnectorAccountRecord;
  bot: TelegramBotIdentity;
}

function buildSecretRedactionFragments(secret: string): readonly string[] {
  const exact = secret.trim();
  if (!exact) return [];
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
  if (error instanceof Error && sanitized === message) return error;
  return new Error(sanitized);
}

async function withSecretErrorSafety<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw sanitizeSecretError(error, secret);
  }
}

function requireTelegramAccountCrypto(crypto: CredentialCrypto | null | undefined): CredentialCrypto {
  if (!crypto) {
    throw new Error("CREDENTIALS_MASTER_KEY is required for Telegram account commands.");
  }
  return crypto;
}

function buildTelegramAccountInput(input: SetTelegramBotAccountInput, bot: TelegramBotIdentity): UpsertConnectorAccountInput {
  return {
    source: TELEGRAM_SOURCE,
    accountKey: input.accountKey,
    connectorKey: bot.id,
    ownerKind: input.ownerKind,
    ownerIdentityId: input.ownerIdentityId,
    ownerAgentKey: input.ownerAgentKey,
    displayName: bot.displayName ?? bot.username,
    externalAccountId: bot.id,
    externalUsername: bot.username,
    status: "enabled",
  };
}

export function createTelegramBotIdentityClient(): TelegramBotIdentityClient {
  return {
    async getBotIdentity(token: string): Promise<TelegramBotIdentity> {
      const bot = new Bot(token);
      const me = await bot.api.getMe();
      return {
        id: String(me.id),
        username: me.username ?? undefined,
        displayName: me.first_name ?? me.username ?? undefined,
      };
    },
  };
}

export async function setTelegramBotAccount(input: SetTelegramBotAccountInput): Promise<TelegramBotAccountResult> {
  const crypto = requireTelegramAccountCrypto(input.crypto);
  const botToken = requireTelegramBotToken({TELEGRAM_BOT_TOKEN: input.botToken} as NodeJS.ProcessEnv);
  const bot = await withSecretErrorSafety(botToken, () => input.client.getBotIdentity(botToken));
  const account = await input.store.upsertAccount(buildTelegramAccountInput(input, bot));
  await withSecretErrorSafety(botToken, () => (
    input.store.setSecret(account.id, TELEGRAM_BOT_TOKEN_SECRET_KEY, botToken, crypto)
  ));
  return {account, bot};
}

export async function validateStoredTelegramBotAccount(input: StoredTelegramBotAccountInput): Promise<TelegramBotAccountResult & {botToken: string}> {
  const crypto = requireTelegramAccountCrypto(input.crypto);
  const account = await input.store.getAccountByKey(TELEGRAM_SOURCE, input.accountKey);
  if (!account) {
    throw new Error(`Unknown Telegram account ${input.accountKey}.`);
  }
  const botToken = await input.store.getSecret(account.id, TELEGRAM_BOT_TOKEN_SECRET_KEY, crypto);
  if (!botToken) {
    throw new Error(`Telegram account ${input.accountKey} does not have a stored bot token.`);
  }
  const bot = await withSecretErrorSafety(botToken, () => input.client.getBotIdentity(botToken));
  if (bot.id !== account.connectorKey) {
    throw new Error("Stored Telegram token identity does not match the connector account.");
  }
  return {account, bot, botToken};
}

export async function disableTelegramBotAccount(input: DisableTelegramBotAccountInput): Promise<{account: ConnectorAccountRecord}> {
  const account = await input.store.disableAccount(TELEGRAM_SOURCE, input.accountKey);
  return {account};
}
