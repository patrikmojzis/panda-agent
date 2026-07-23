import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresTelegramStickerStore} from "../src/domain/agents/telegram-stickers/postgres.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

describe("PostgresTelegramStickerStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function stores() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "hashtext",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    db.public.registerFunction({
      name: "pg_advisory_xact_lock",
      args: [DataType.integer],
      returns: DataType.void,
      implementation: () => undefined,
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const identities = new PostgresIdentityStore({pool});
    const agents = new PostgresAgentStore({pool});
    const stickers = new PostgresTelegramStickerStore({pool});
    await identities.ensureSchema();
    await agents.ensureSchema();
    await stickers.ensureSchema();
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await agents.bootstrapAgent({agentKey: "other", displayName: "Other"});
    return {stickers};
  }

  it("persists, deduplicates, and searches stickers within one agent", async () => {
    const {stickers} = await stores();
    const sticker = {
      fileId: "file-v1",
      fileUniqueId: "stable-unique",
      setName: "PandaPack",
      setTitle: "Panda Pack",
      emoji: "🐼",
      stickerType: "regular" as const,
      format: "static" as const,
      width: 512,
      height: 512,
    };

    await expect(stickers.importStickers({
      agentKey: "panda",
      connectorKey: "telegram-main",
      stickers: [sticker],
      tags: ["support"],
      description: "Support panda",
    })).resolves.toMatchObject({createdCount: 1, updatedCount: 0});
    await expect(stickers.importStickers({
      agentKey: "panda",
      connectorKey: "telegram-main",
      stickers: [{...sticker, fileId: "file-v2"}],
      tags: ["favorite"],
    })).resolves.toMatchObject({createdCount: 0, updatedCount: 1});
    await stickers.importStickers({
      agentKey: "other",
      connectorKey: "telegram-main",
      stickers: [sticker],
      tags: ["hidden"],
    });

    await expect(stickers.listStickers({
      agentKey: "panda",
      query: "support",
      tag: "favorite",
    })).resolves.toEqual([
      expect.objectContaining({
        agentKey: "panda",
        fileId: "file-v2",
        fileUniqueId: "stable-unique",
        tags: ["support", "favorite"],
        description: "Support panda",
      }),
    ]);
  });
});
