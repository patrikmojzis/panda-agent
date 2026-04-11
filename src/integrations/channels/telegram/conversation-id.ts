export interface ParsedTelegramConversationId {
  chatId: string;
  messageThreadId?: number;
}

export function parseTelegramConversationId(value: string): ParsedTelegramConversationId {
  const trimmed = value.trim();
  const match = /^(-?\d+)(?::(\d+))?$/.exec(trimmed);
  if (!match?.[1]) {
    throw new Error(`Invalid Telegram conversation id ${value}.`);
  }

  return {
    chatId: match[1],
    messageThreadId: match[2] ? Number.parseInt(match[2], 10) : undefined,
  };
}
