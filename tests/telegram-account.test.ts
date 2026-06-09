import {describe, expect, it, vi} from "vitest";

import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {
  setTelegramBotAccount,
  validateStoredTelegramBotAccount,
  type TelegramAccountStore,
  type TelegramBotIdentity,
} from "../src/integrations/channels/telegram/account.js";
import {TELEGRAM_BOT_TOKEN_SECRET_KEY, TELEGRAM_SOURCE} from "../src/integrations/channels/telegram/config.js";

const privateToken = "123456:telegram-private-token-fragment-12345678";
const bot: TelegramBotIdentity = {
  id: "424242",
  username: "panda_bot",
  displayName: "Panda Bot",
};

function makeStore(overrides: Partial<ReturnType<typeof makeStoreBase>> = {}): TelegramAccountStore {
  return {...makeStoreBase(), ...overrides};
}

function makeStoreBase() {
  const account = {
    id: "account-1",
    source: TELEGRAM_SOURCE,
    accountKey: "ops",
    connectorKey: bot.id,
    ownerKind: "system" as const,
    ownerIdentityId: null,
    ownerAgentKey: null,
    displayName: bot.displayName,
    externalAccountId: bot.id,
    externalUsername: bot.username,
    status: "enabled" as const,
    config: {},
    createdAt: 1,
    updatedAt: 2,
  };

  return {
    upsertAccount: vi.fn(async (input) => ({
      ...account,
      accountKey: input.accountKey,
      connectorKey: input.connectorKey,
      ownerKind: input.ownerIdentityId ? "identity" as const : input.ownerAgentKey ? "agent" as const : "system" as const,
      ownerIdentityId: input.ownerIdentityId ?? null,
      ownerAgentKey: input.ownerAgentKey ?? null,
      displayName: input.displayName,
      externalAccountId: input.externalAccountId,
      externalUsername: input.externalUsername,
      status: input.status ?? "enabled" as const,
    })),
    getAccountByKey: vi.fn(async () => account),
    disableAccount: vi.fn(async () => ({...account, status: "disabled" as const})),
    setSecret: vi.fn(async () => ({accountId: account.id, secretKey: TELEGRAM_BOT_TOKEN_SECRET_KEY, createdAt: 1, updatedAt: 2})),
    getSecret: vi.fn(async () => privateToken),
  };
}

describe("Telegram account adapter", () => {
  it("derives connector account fields and stores the token only through the encrypted secret path", async () => {
    const store = makeStore({getAccountByKey: vi.fn(async () => null)});
    const crypto = new CredentialCrypto("telegram-account-test-master-key");
    const client = {getBotIdentity: vi.fn(async () => bot)};

    const result = await setTelegramBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
      ownerAgentKey: "clawd",
    });

    expect(client.getBotIdentity).toHaveBeenCalledWith(privateToken);
    expect(store.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      source: TELEGRAM_SOURCE,
      accountKey: "ops",
      connectorKey: bot.id,
      ownerAgentKey: "clawd",
      displayName: bot.displayName,
      externalAccountId: bot.id,
      externalUsername: bot.username,
      status: "enabled",
    }));
    expect(store.setSecret).toHaveBeenCalledWith("account-1", TELEGRAM_BOT_TOKEN_SECRET_KEY, privateToken, crypto);
    expect(JSON.stringify(result)).not.toContain(privateToken);
  });

  it("validates stored accounts and fails closed on bot-id connector mismatch", async () => {
    const store = makeStore();
    const crypto = new CredentialCrypto("telegram-account-test-master-key");
    const client = {getBotIdentity: vi.fn(async () => ({...bot, id: "999"}))};

    await expect(validateStoredTelegramBotAccount({
      accountKey: "ops",
      client,
      crypto,
      store,
    })).rejects.toThrow("Stored Telegram token identity does not match the connector account.");
    expect(store.getSecret).toHaveBeenCalledWith("account-1", TELEGRAM_BOT_TOKEN_SECRET_KEY, crypto);
  });

  it("redacts token material if setup dependencies fail unsafely", async () => {
    const store = makeStore({getAccountByKey: vi.fn(async () => null)});
    const crypto = new CredentialCrypto("telegram-account-test-master-key");
    const client = {
      getBotIdentity: vi.fn(async () => {
        throw new Error(`bad token ${privateToken} fragment 12345678`);
      }),
    };

    await expect(setTelegramBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
    })).rejects.toThrow("[redacted]");
    await expect(setTelegramBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
    })).rejects.not.toThrow(privateToken);
    expect(store.upsertAccount).not.toHaveBeenCalled();
  });
  it("requires explicit replacement before overwriting an existing account key", async () => {
    const store = makeStore();
    const crypto = new CredentialCrypto("telegram-account-test-master-key");
    const client = {getBotIdentity: vi.fn(async () => bot)};

    await expect(setTelegramBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
    })).rejects.toThrow("already exists");
    expect(store.upsertAccount).not.toHaveBeenCalled();

    await expect(setTelegramBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      replace: true,
      client,
      crypto,
      store,
    })).resolves.toMatchObject({account: expect.objectContaining({accountKey: "ops"})});
  });

});
