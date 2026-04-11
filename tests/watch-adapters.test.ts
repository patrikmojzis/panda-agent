import {afterEach, describe, expect, it, vi} from "vitest";
import type {WatchRecord} from "../src/domain/watches/index.js";
import {evaluateWatch, validateReadOnlySqlQuery,} from "../src/domain/watches/index.js";

const adapterMocks = vi.hoisted(() => {
  const state = {
    mongoRows: [] as Array<Record<string, unknown>>,
    postgresRows: [] as Array<Record<string, unknown>>,
    postgresQueries: [] as string[],
    mysqlRows: [] as Array<Record<string, unknown>>,
    mysqlQueries: [] as string[],
    imapMailbox: {
      exists: 0,
      uidValidity: 1,
    },
    imapMessages: [] as Array<Record<string, unknown>>,
    imapFetchCalls: [] as Array<{range: string; uidMode: boolean}>,
    imapFetchOneCalls: [] as string[],
  };

  class MockMongoClient {
    constructor(_uri: string) {}

    async connect(): Promise<void> {}

    db(_name: string) {
      return {
        collection(_collection: string) {
          return {
            find(_filter: Record<string, unknown>, _options: Record<string, unknown>) {
              return {
                limit(_limit: number) {
                  return {
                    async toArray() {
                      return state.mongoRows;
                    },
                  };
                },
              };
            },
            aggregate(_pipeline: Record<string, unknown>[]) {
              return {
                limit(_limit: number) {
                  return {
                    async toArray() {
                      return state.mongoRows;
                    },
                  };
                },
              };
            },
          };
        },
      };
    }

    async close(): Promise<void> {}
  }

  class MockPgPool {
    constructor(_options: unknown) {}

    async query(_query: string, _parameters: readonly unknown[]) {
      return {
        rows: state.postgresRows,
      };
    }

    async connect() {
      return {
        query: async (query: string, _parameters?: readonly unknown[]) => {
          state.postgresQueries.push(query);
          if (query === "BEGIN READ ONLY" || query.startsWith("SET LOCAL ") || query === "COMMIT" || query === "ROLLBACK") {
            return {rows: []};
          }
          return {
            rows: state.postgresRows,
          };
        },
        release() {},
      };
    }

    async end(): Promise<void> {}
  }

  const createMysqlConnection = vi.fn(async (_connectionString: string) => ({
    async query(_query: string, _parameters: readonly unknown[]) {
      state.mysqlQueries.push(_query);
      if (_query === "START TRANSACTION READ ONLY" || _query === "COMMIT" || _query === "ROLLBACK") {
        return [[]];
      }
      return [state.mysqlRows];
    },
    async end(): Promise<void> {},
  }));

  class MockImapFlow {
    mailbox = state.imapMailbox;

    constructor(_options: unknown) {}

    async connect(): Promise<void> {}

    async getMailboxLock(_mailbox: string, _options: {readOnly: boolean}) {
      return {
        release() {},
      };
    }

    async *fetch(
      range: string,
      _query: {uid: boolean; envelope: boolean; internalDate: boolean},
      options?: {uid?: boolean},
    ) {
      state.imapFetchCalls.push({
        range,
        uidMode: Boolean(options?.uid),
      });
      const start = Number.parseInt(range.split(":")[0] ?? "1", 10);
      for (const message of state.imapMessages) {
        if (options?.uid && typeof message.uid === "number" && message.uid < start) {
          continue;
        }
        yield message;
      }
    }

    async fetchOne(
      seq: string,
      _query: {uid: boolean; envelope: boolean; internalDate: boolean},
    ) {
      state.imapFetchOneCalls.push(seq);
      const sequence = Number.parseInt(seq, 10);
      if (!Number.isFinite(sequence) || sequence <= 0) {
        return false;
      }
      return state.imapMessages[sequence - 1] ?? false;
    }

    async logout(): Promise<void> {}
  }

  return {
    state,
    MockMongoClient,
    MockPgPool,
    createMysqlConnection,
    MockImapFlow,
  };
});

vi.mock("mongodb", () => ({
  MongoClient: adapterMocks.MockMongoClient,
}));

vi.mock("pg", () => ({
  Pool: adapterMocks.MockPgPool,
}));

vi.mock("mysql2/promise", () => ({
  createConnection: adapterMocks.createMysqlConnection,
}));

vi.mock("imapflow", () => ({
  ImapFlow: adapterMocks.MockImapFlow,
}));

function createCredentialResolver() {
  return {
    resolveCredential: vi.fn(async (envKey: string) => ({
      id: envKey,
      envKey,
      value: `secret-for-${envKey}`,
      scope: "relationship",
      identityId: "identity-1",
      agentKey: "panda",
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

function createWatch(overrides: Partial<WatchRecord>): WatchRecord {
  return {
    id: "watch-1",
    identityId: "identity-1",
    agentKey: "panda",
    title: "watch",
    intervalMinutes: 5,
    targetKind: "home",
    source: {
      kind: "mongodb_query",
      credentialEnvKey: "SOURCE_SECRET",
      database: "app",
      collection: "events",
      operation: "find",
      result: {
        observation: "collection",
        itemIdField: "_id",
        itemCursorField: "createdAt",
      },
    },
    detector: {
      kind: "new_items",
    },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("watch adapters", () => {
  afterEach(() => {
    adapterMocks.state.mongoRows = [];
    adapterMocks.state.postgresRows = [];
    adapterMocks.state.postgresQueries = [];
    adapterMocks.state.mysqlRows = [];
    adapterMocks.state.mysqlQueries = [];
    adapterMocks.state.imapMailbox = {
      exists: 0,
      uidValidity: 1,
    };
    adapterMocks.state.imapMessages = [];
    adapterMocks.state.imapFetchCalls = [];
    adapterMocks.state.imapFetchOneCalls = [];
    adapterMocks.createMysqlConnection.mockClear();
  });

  it("Mongo new_items watches respect configured id/cursor fields and only emit newer docs", async () => {
    adapterMocks.state.mongoRows = [
      {_id: "reg-1", createdAt: "2026-04-11T10:00:00.000Z", email: "a@example.com"},
      {_id: "reg-2", createdAt: "2026-04-11T10:05:00.000Z", email: "b@example.com"},
    ];
    const credentialResolver = createCredentialResolver();
    const watch = createWatch({
      source: {
        kind: "mongodb_query",
        credentialEnvKey: "MONGO_URI",
        database: "app",
        collection: "registrations",
        operation: "find",
        result: {
          observation: "collection",
          itemIdField: "_id",
          itemCursorField: "createdAt",
          fields: ["email"],
        },
      },
      state: {
        kind: "new_items",
        bootstrapped: true,
        lastCursor: "2026-04-11T10:00:00.000Z",
        lastIds: ["reg-1"],
      },
    });

    const result = await evaluateWatch(watch, {
      credentialResolver: credentialResolver as any,
    });

    expect(result.changed).toBe(true);
    expect(result.event?.payload).toMatchObject({
      totalNewItems: 1,
      items: [{
        id: "reg-2",
        cursor: "2026-04-11T10:05:00.000Z",
        data: {
          email: "b@example.com",
        },
      }],
    });
  });

  it("SQL validation rejects mutating or multi-statement queries", () => {
    expect(() => validateReadOnlySqlQuery("select 1; delete from users"))
      .toThrow("SQL watch query must be a single statement.");
    expect(() => validateReadOnlySqlQuery("update users set admin = true"))
      .toThrow("SQL watch query must start with SELECT or WITH.");
  });

  it("SQL new_items watches emit only new rows for postgres and mysql", async () => {
    const credentialResolver = createCredentialResolver();
    const postgresWatch = createWatch({
      source: {
        kind: "sql_query",
        credentialEnvKey: "POSTGRES_URL",
        dialect: "postgres",
        query: "select id, created_at from registrations order by created_at asc",
        result: {
          observation: "collection",
          itemIdField: "id",
          itemCursorField: "created_at",
        },
      },
      state: {
        kind: "new_items",
        bootstrapped: true,
        lastCursor: "2026-04-11T10:00:00.000Z",
        lastIds: ["row-1"],
      },
    });
    adapterMocks.state.postgresRows = [
      {id: "row-1", created_at: "2026-04-11T10:00:00.000Z"},
      {id: "row-2", created_at: "2026-04-11T10:10:00.000Z"},
    ];

    const postgresResult = await evaluateWatch(postgresWatch, {
      credentialResolver: credentialResolver as any,
    });
    expect(postgresResult.changed).toBe(true);
    expect(postgresResult.event?.payload).toMatchObject({
      totalNewItems: 1,
      items: [{
        id: "row-2",
      }],
    });
    expect(adapterMocks.state.postgresQueries).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '500ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
      "select id, created_at from registrations order by created_at asc",
      "COMMIT",
    ]);

    const mysqlWatch = createWatch({
      source: {
        kind: "sql_query",
        credentialEnvKey: "MYSQL_URL",
        dialect: "mysql",
        query: "select id, created_at from registrations order by created_at asc",
        result: {
          observation: "collection",
          itemIdField: "id",
          itemCursorField: "created_at",
        },
      },
      state: {
        kind: "new_items",
        bootstrapped: true,
        lastCursor: "2026-04-11T10:00:00.000Z",
        lastIds: ["row-1"],
      },
    });
    adapterMocks.state.mysqlRows = [
      {id: "row-1", created_at: "2026-04-11T10:00:00.000Z"},
      {id: "row-3", created_at: "2026-04-11T10:15:00.000Z"},
    ];

    const mysqlResult = await evaluateWatch(mysqlWatch, {
      credentialResolver: credentialResolver as any,
    });
    expect(mysqlResult.changed).toBe(true);
    expect(mysqlResult.event?.payload).toMatchObject({
      totalNewItems: 1,
      items: [{
        id: "row-3",
      }],
    });
    expect(adapterMocks.createMysqlConnection).toHaveBeenCalledTimes(1);
    expect(adapterMocks.state.mysqlQueries).toEqual([
      "START TRANSACTION READ ONLY",
      "select id, created_at from registrations order by created_at asc",
      "COMMIT",
    ]);
  });

  it("IMAP watches ignore existing mail on first run and emit every UID newer than the stored cursor", async () => {
    const credentialResolver = createCredentialResolver();
    const watch = createWatch({
      title: "Inbox",
      source: {
        kind: "imap_mailbox",
        host: "imap.example.com",
        username: "alice@example.com",
        passwordCredentialEnvKey: "IMAP_PASSWORD",
        maxMessages: 1,
      },
      detector: {
        kind: "new_items",
      },
    });

    adapterMocks.state.imapMailbox = {
      exists: 2,
      uidValidity: 42,
    };
    adapterMocks.state.imapMessages = [
      {
        uid: 101,
        envelope: {
          subject: "First",
          from: [{name: "Alice", address: "alice@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:00:00.000Z"),
      },
      {
        uid: 102,
        envelope: {
          subject: "Second",
          from: [{name: "Bob", address: "bob@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:05:00.000Z"),
      },
    ];

    const first = await evaluateWatch(watch, {
      credentialResolver: credentialResolver as any,
    });
    expect(first.changed).toBe(false);
    expect(first.nextState).toMatchObject({
      kind: "new_items",
      identityToken: "42",
      lastCursor: 102,
      lastIds: ["102"],
    });
    expect(adapterMocks.state.imapFetchOneCalls).toEqual(["2"]);
    expect(adapterMocks.state.imapFetchCalls).toEqual([]);

    adapterMocks.state.imapMailbox = {
      exists: 5,
      uidValidity: 42,
    };
    adapterMocks.state.imapMessages = [
      {
        uid: 101,
        envelope: {
          subject: "First",
          from: [{name: "Alice", address: "alice@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:00:00.000Z"),
      },
      {
        uid: 102,
        envelope: {
          subject: "Second",
          from: [{name: "Bob", address: "bob@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:05:00.000Z"),
      },
      {
        uid: 103,
        envelope: {
          subject: "Third",
          from: [{name: "Cara", address: "cara@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:10:00.000Z"),
      },
      {
        uid: 104,
        envelope: {
          subject: "Fourth",
          from: [{name: "Dora", address: "dora@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:15:00.000Z"),
      },
      {
        uid: 105,
        envelope: {
          subject: "Fifth",
          from: [{name: "Eli", address: "eli@example.com"}],
        },
        internalDate: new Date("2026-04-11T10:20:00.000Z"),
      },
    ];

    const second = await evaluateWatch({
      ...watch,
      state: first.nextState,
    }, {
      credentialResolver: credentialResolver as any,
    });
    expect(second.changed).toBe(true);
    expect(second.event?.payload).toMatchObject({
      totalNewItems: 3,
      items: [{
        id: "105",
        cursor: 105,
        summary: "Fifth",
      }, {
        id: "104",
        cursor: 104,
        summary: "Fourth",
      }, {
        id: "103",
        cursor: 103,
        summary: "Third",
      }],
    });
    expect(adapterMocks.state.imapFetchCalls).toEqual([{
      range: "103:*",
      uidMode: true,
    }]);
  });
});
