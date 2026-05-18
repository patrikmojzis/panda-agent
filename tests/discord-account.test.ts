import {describe, expect, it, vi} from "vitest";

import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {
  setDiscordBotAccount,
  validateStoredDiscordBotAccount,
  type DiscordAccountStore,
} from "../src/integrations/channels/discord/account.js";
import {createDiscordRestClient, type DiscordCurrentUser} from "../src/integrations/channels/discord/api.js";
import {DISCORD_BOT_TOKEN_SECRET_KEY, DISCORD_SOURCE} from "../src/integrations/channels/discord/config.js";

const privateToken = "discord-private-token-fragment-12345678";
const botUser: DiscordCurrentUser = {
  id: "123456789012345678",
  username: "panda-bot",
  displayName: "Panda Bot",
  globalName: "Panda Bot",
  bot: true,
};

function makeStore(): DiscordAccountStore {
  const account = {
    id: "account-1",
    source: DISCORD_SOURCE,
    accountKey: "ops",
    connectorKey: botUser.id,
    ownerKind: "system" as const,
    ownerIdentityId: null,
    ownerAgentKey: null,
    displayName: botUser.displayName,
    externalAccountId: botUser.id,
    externalUsername: botUser.username,
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
      ownerKind: input.ownerIdentityId ? "identity" : input.ownerAgentKey ? "agent" : "system",
      ownerIdentityId: input.ownerIdentityId ?? null,
      ownerAgentKey: input.ownerAgentKey ?? null,
      displayName: input.displayName,
      externalAccountId: input.externalAccountId,
      externalUsername: input.externalUsername,
      status: input.status ?? "enabled",
    })),
    getAccountByKey: vi.fn(async () => account),
    disableAccount: vi.fn(async () => ({
      ...account,
      status: "disabled" as const,
    })),
    setSecret: vi.fn(async () => ({
      accountId: account.id,
      secretKey: DISCORD_BOT_TOKEN_SECRET_KEY,
      createdAt: 1,
      updatedAt: 2,
    })),
    getSecret: vi.fn(async () => privateToken),
  };
}

describe("Discord account adapter", () => {
  it("validates bot tokens with GET /users/@me and parses safe identity fields", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: botUser.id,
        username: botUser.username,
        global_name: botUser.globalName,
        bot: true,
      }),
    }));
    const client = createDiscordRestClient({
      apiBaseUrl: "https://discord.example/api/v10/",
      fetcher,
    });

    await expect(client.getCurrentUser(privateToken)).resolves.toEqual(botUser);
    expect(fetcher).toHaveBeenCalledWith("https://discord.example/api/v10/users/@me", {
      method: "GET",
      headers: expect.objectContaining({
        Accept: "application/json",
        Authorization: `Bot ${privateToken}`,
      }),
    });
  });

  it("sanitizes Discord REST failures instead of echoing token values", async () => {
    const client = createDiscordRestClient({
      fetcher: vi.fn(async () => {
        throw new Error(`network failure for ${privateToken}`);
      }),
    });

    try {
      await client.getCurrentUser(privateToken);
      throw new Error("Expected Discord token validation to fail.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("request failed");
      expect(message).not.toContain(privateToken);
      expect(message).not.toContain("12345678");
    }
  });

  it("derives connector account fields and stores the token only through the encrypted secret path", async () => {
    const store = makeStore();
    const crypto = new CredentialCrypto("discord-account-test-master-key");
    const client = {
      getCurrentUser: vi.fn(async () => botUser),
    };

    const result = await setDiscordBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
      ownerIdentityId: "identity-alice",
    });

    expect(client.getCurrentUser).toHaveBeenCalledWith(privateToken);
    expect(store.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      source: DISCORD_SOURCE,
      accountKey: "ops",
      connectorKey: botUser.id,
      ownerIdentityId: "identity-alice",
      displayName: botUser.displayName,
      externalAccountId: botUser.id,
      externalUsername: botUser.username,
      status: "enabled",
    }));
    expect(store.setSecret).toHaveBeenCalledWith(
      "account-1",
      DISCORD_BOT_TOKEN_SECRET_KEY,
      privateToken,
      crypto,
    );
    expect(JSON.stringify(result)).not.toContain(privateToken);
  });

  it("redacts token material if account setup dependencies fail unsafely", async () => {
    const store = makeStore();
    const crypto = new CredentialCrypto("discord-account-test-master-key");
    const client = {
      getCurrentUser: vi.fn(async () => {
        throw new Error(`bad token ${privateToken} and fragment 12345678`);
      }),
    };

    await expect(setDiscordBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
    })).rejects.toThrow("[redacted]");
    await expect(setDiscordBotAccount({
      accountKey: "ops",
      botToken: privateToken,
      client,
      crypto,
      store,
    })).rejects.not.toThrow(privateToken);
    expect(store.upsertAccount).not.toHaveBeenCalled();
  });

  it("validates stored accounts without exposing the decrypted token", async () => {
    const store = makeStore();
    const crypto = new CredentialCrypto("discord-account-test-master-key");
    const client = {
      getCurrentUser: vi.fn(async () => botUser),
    };

    await expect(validateStoredDiscordBotAccount({
      accountKey: "ops",
      client,
      crypto,
      store,
    })).resolves.toMatchObject({
      account: {accountKey: "ops", connectorKey: botUser.id},
      botUser: {id: botUser.id, username: botUser.username},
    });
    expect(store.getSecret).toHaveBeenCalledWith("account-1", DISCORD_BOT_TOKEN_SECRET_KEY, crypto);
    expect(client.getCurrentUser).toHaveBeenCalledWith(privateToken);
  });
});
