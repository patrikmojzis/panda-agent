export const DISCORD_SOURCE = "discord";
export const DISCORD_BOT_TOKEN_SECRET_KEY = "bot_token";
export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg";
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

export const DISCORD_GATEWAY_INTENTS = {
  guildMessages: 1 << 9,
  directMessages: 1 << 12,
  messageContent: 1 << 15,
} as const;

export const DISCORD_DEFAULT_GATEWAY_INTENTS =
  DISCORD_GATEWAY_INTENTS.guildMessages
  | DISCORD_GATEWAY_INTENTS.directMessages
  | DISCORD_GATEWAY_INTENTS.messageContent;
