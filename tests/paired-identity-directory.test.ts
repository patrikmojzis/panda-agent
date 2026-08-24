import {describe, expect, it} from "vitest";

import {PostgresPairedIdentityDirectory} from "../src/domain/agents/paired-identity-directory.js";
import type {PgQueryable, PgQueryResult} from "../src/lib/postgres-query.js";

interface QueryCall {
  sql: string;
  params: readonly unknown[];
}

class ScriptedQuery implements PgQueryable {
  readonly calls: QueryCall[] = [];
  private readonly results: PgQueryResult[];

  constructor(results: PgQueryResult[]) {
    this.results = [...results];
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    this.calls.push({sql, params});
    const result = this.results.shift();
    if (!result) {
      throw new Error("Unexpected paired identity directory query.");
    }
    return result;
  }
}

function identityRows(count: number): Array<Record<string, unknown>> {
  return Array.from({length: count}, (_, index) => ({
    identity_id: `identity-${index}`,
    handle: `person-${index}`,
    display_name: `Person ${index}`,
  }));
}

describe("PostgresPairedIdentityDirectory", () => {
  it("keeps its query budget constant for the maximum prompt identity window", async () => {
    const pool = new ScriptedQuery([
      {rows: identityRows(25)},
      {
        rows: [{
          identity_id: "identity-0",
          channel: "telegram",
          connector_key: "bot-main",
          external_conversation_id: "chat-1",
          external_actor_id: "telegram-user",
        }],
      },
      {
        rows: [
          {
            identity_id: "identity-0",
            source: "whatsapp",
            connector_key: "wa-main",
            external_actor_id: "wa-user-1",
            binding_count: "6",
          },
          {
            identity_id: "identity-0",
            source: "discord",
            connector_key: "discord-main",
            external_actor_id: "discord-user",
            binding_count: "6",
          },
          {
            identity_id: "identity-0",
            source: "email",
            connector_key: "email-main",
            external_actor_id: "person@example.com",
            binding_count: "6",
          },
          {
            identity_id: "identity-0",
            source: "telegram",
            connector_key: "bot-secondary",
            external_actor_id: "telegram-user-2",
            binding_count: "6",
          },
        ],
      },
    ]);
    const directory = new PostgresPairedIdentityDirectory({pool});

    const entries = await directory.listForSession({
      sessionId: "session-main",
      identityLimit: 25,
      bindingLimit: 4,
    });

    expect(pool.calls).toHaveLength(3);
    expect(pool.calls[0]?.params).toEqual(["session-main", 25]);
    expect(pool.calls[1]?.params).toEqual([
      "session-main",
      identityRows(25).map((row) => row.identity_id),
    ]);
    expect(pool.calls[2]?.params).toEqual([
      identityRows(25).map((row) => row.identity_id),
      JSON.stringify([{
        identityId: "identity-0",
        source: "telegram",
        connectorKey: "bot-main",
        externalActorId: "telegram-user",
      }]),
      4,
    ]);
    expect(entries).toHaveLength(25);
    expect(entries[0]).toEqual({
      identityId: "identity-0",
      handle: "person-0",
      displayName: "Person 0",
      recentRoute: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-1",
        externalActorId: "telegram-user",
      },
      bindings: [
        {
          source: "whatsapp",
          connectorKey: "wa-main",
          externalActorId: "wa-user-1",
        },
        {
          source: "discord",
          connectorKey: "discord-main",
          externalActorId: "discord-user",
        },
        {
          source: "email",
          connectorKey: "email-main",
          externalActorId: "person@example.com",
        },
        {
          source: "telegram",
          connectorKey: "bot-secondary",
          externalActorId: "telegram-user-2",
        },
      ],
      additionalBindingCount: 2,
    });
    expect(entries[24]).toMatchObject({
      identityId: "identity-24",
      bindings: [],
      additionalBindingCount: 0,
    });
  });

  it("stops after the session lookup when no active identities are paired", async () => {
    const pool = new ScriptedQuery([{rows: []}]);
    const directory = new PostgresPairedIdentityDirectory({pool});

    await expect(directory.listForSession({
      sessionId: "session-empty",
      identityLimit: 25,
      bindingLimit: 4,
    })).resolves.toEqual([]);
    expect(pool.calls).toHaveLength(1);
  });

  it("rejects unbounded prompt windows before querying Postgres", async () => {
    const pool = new ScriptedQuery([]);
    const directory = new PostgresPairedIdentityDirectory({pool});

    await expect(directory.listForSession({
      sessionId: "session-main",
      identityLimit: 101,
      bindingLimit: 4,
    })).rejects.toThrow("Paired identity limit must be an integer between 1 and 100.");
    await expect(directory.listForSession({
      sessionId: "session-main",
      identityLimit: 25,
      bindingLimit: 21,
    })).rejects.toThrow("Paired identity binding limit must be an integer between 1 and 20.");
    expect(pool.calls).toHaveLength(0);
  });
});
