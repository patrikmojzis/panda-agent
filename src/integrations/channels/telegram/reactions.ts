// Keep Telegram's provider-specific reaction allowlist out of the Zod schema.
// Tool schemas are exposed to the model, and this list is runtime validation
// detail, not something worth carrying around in prompt context every turn.
export const ALLOWED_TELEGRAM_REACTION_EMOJI_LIST = [
  "❤",
  "👍",
  "👎",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const;

const ALLOWED_TELEGRAM_REACTION_EMOJIS = new Set<string>(ALLOWED_TELEGRAM_REACTION_EMOJI_LIST);

interface TelegramEmojiReaction {
  type: "emoji";
  emoji: string;
}

function isTelegramEmojiReaction(value: unknown): value is TelegramEmojiReaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === "emoji" && typeof candidate.emoji === "string" && candidate.emoji.trim().length > 0;
}

export function isAllowedTelegramReactionEmoji(value: string): boolean {
  return ALLOWED_TELEGRAM_REACTION_EMOJIS.has(value);
}

export function parseTelegramReactionMessageId(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid Telegram message id ${value}.`);
  }

  return parsed;
}

export function extractAddedTelegramReactionEmojis(
  oldReaction: readonly unknown[],
  newReaction: readonly unknown[],
): string[] {
  const oldEmojis = new Set(
    oldReaction
      .filter(isTelegramEmojiReaction)
      .map((entry) => entry.emoji.trim()),
  );

  return newReaction
    .filter(isTelegramEmojiReaction)
    .map((entry) => entry.emoji.trim())
    .filter((emoji) => emoji && !oldEmojis.has(emoji));
}
