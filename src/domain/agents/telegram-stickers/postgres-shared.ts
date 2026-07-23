import {buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";

export interface TelegramStickerTableNames {
  prefix: string;
  stickers: string;
}

export function buildTelegramStickerTableNames(): TelegramStickerTableNames {
  return buildRuntimeRelationNames({
    stickers: "agent_telegram_stickers",
  });
}
