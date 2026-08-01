import type {DiscordStickerSendActionPayload} from "../../../domain/channels/actions/types.js";
import type {ConnectorAccountListFilter, ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {requireNonEmptyString} from "../../../lib/strings.js";
import type {DiscordStickerCatalogReader} from "./commands.js";
import {DISCORD_BOT_TOKEN_SECRET_KEY, DISCORD_SOURCE} from "./config.js";
import type {DiscordMessageReferenceBody, DiscordWorkerRestClient} from "./api.js";

interface DiscordStickerAccountStore {
  listAccounts(filter?: ConnectorAccountListFilter): Promise<readonly ConnectorAccountRecord[]>;
  getSecret(accountId: string, key: string, crypto: CredentialCrypto): Promise<string | null>;
}

export function createDiscordStickerCatalogReader(options: {
  accounts: DiscordStickerAccountStore;
  client: Pick<DiscordWorkerRestClient, "getChannelMetadata" | "listGuildStickers">;
  crypto: CredentialCrypto | null;
}): DiscordStickerCatalogReader {
  return {
    async listGuildStickersForChannel(input) {
      if (!options.crypto) {
        throw new Error("CREDENTIALS_MASTER_KEY is required for Discord sticker discovery.");
      }
      const accounts = await options.accounts.listAccounts({source: DISCORD_SOURCE, status: "enabled"});
      const account = accounts.find((candidate) => candidate.connectorKey === input.connectorKey);
      if (!account) {
        throw new Error("Discord sticker discovery found no matching enabled connector.");
      }
      const botToken = await options.accounts.getSecret(account.id, DISCORD_BOT_TOKEN_SECRET_KEY, options.crypto);
      if (!botToken) {
        throw new Error("Discord sticker discovery found no bot token for the connector.");
      }
      const channel = await options.client.getChannelMetadata(botToken, input.channelId);
      if (!channel.guildId) {
        throw new Error("Discord sticker discovery requires a guild channel.");
      }
      return {
        guildId: channel.guildId,
        stickers: await options.client.listGuildStickers(botToken, channel.guildId),
      };
    },
  };
}

function buildMessageReference(
  payload: DiscordStickerSendActionPayload,
  channelId: string,
): DiscordMessageReferenceBody | undefined {
  if (!payload.replyToMessageId) {
    return undefined;
  }
  return {
    message_id: payload.replyToMessageId,
    channel_id: channelId,
    ...(payload.guildId ? {guild_id: payload.guildId} : {}),
    fail_if_not_exists: false,
  };
}

export async function sendDiscordStickerAction(
  payload: DiscordStickerSendActionPayload,
  options: {
    botToken: string;
    client: Pick<DiscordWorkerRestClient, "createMessage">;
  },
): Promise<void> {
  const channelId = requireNonEmptyString(
    payload.threadId ?? payload.parentChannelId,
    "Discord sticker target channel id must not be empty.",
  );
  if (payload.stickerIds.length < 1 || payload.stickerIds.length > 3) {
    throw new Error("Discord sticker send requires 1-3 sticker ids.");
  }
  const messageReference = buildMessageReference(payload, channelId);
  await options.client.createMessage(options.botToken, channelId, {
    allowed_mentions: {parse: []},
    sticker_ids: payload.stickerIds,
    ...(messageReference ? {message_reference: messageReference} : {}),
  });
}
