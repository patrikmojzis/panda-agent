import {randomUUID} from "node:crypto";

import {Pool} from "pg";
import {describe, expect, it} from "vitest";

import {PostgresPairedIdentityDirectory} from "../../src/domain/agents/paired-identity-directory.js";
import {ensurePostgresAgentSchema} from "../../src/domain/agents/postgres-schema.js";
import {ensurePostgresIdentitySchema} from "../../src/domain/identity/postgres-schema.js";
import {ensurePostgresSessionRouteSchema} from "../../src/domain/sessions/routes/postgres-schema.js";
import type {PgQueryable, PgQueryResult} from "../../src/lib/postgres-query.js";
import {quoteIdentifier} from "../../src/lib/postgres-relations.js";

class SchemaScopedQuery implements PgQueryable {
  calls = 0;

  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    this.calls += 1;
    const scopedSql = sql
      .replaceAll('CREATE SCHEMA IF NOT EXISTS "runtime"', `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`)
      .replaceAll('"runtime".', `${quoteIdentifier(this.schema)}.`)
      .replaceAll("'runtime'", `'${this.schema}'`)
      // Schema installers inspect information_schema without a schema clause
      // for pg-mem compatibility. Keep this live fixture isolated from the
      // disposable database's intentionally unsafe startup-rehearsal residue.
      .replace(
        "WHERE table_name = 'session_routes'",
        `WHERE table_schema = '${this.schema}' AND table_name = 'session_routes'`,
      );
    const scopedParams = params.map((value) => value === "runtime" ? this.schema : value);
    const result = await this.pool.query(scopedSql, scopedParams);
    return {rows: result.rows, rowCount: result.rowCount};
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const postgresIt = databaseUrl ? it : it.skip;

describe("PostgresPairedIdentityDirectory with PostgreSQL", () => {
  it("requires TEST_DATABASE_URL for the PostgreSQL contract check", () => {
    expect(databaseUrl).toMatch(/^postgres(?:ql)?:\/\//);
  });

  postgresIt("executes the bounded route-first directory projection", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-paired-identity-directory",
      max: 1,
    });
    const schema = `paired_identity_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      schemaCreated = true;
      await pool.query(`
        CREATE TABLE ${quotedSchema}.agent_sessions (
          id TEXT PRIMARY KEY,
          agent_key TEXT NOT NULL
        );
        CREATE TABLE ${quotedSchema}.identities (
          id TEXT PRIMARY KEY,
          handle TEXT NOT NULL,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE ${quotedSchema}.agent_pairings (
          agent_key TEXT NOT NULL,
          identity_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (agent_key, identity_id)
        );
        CREATE TABLE ${quotedSchema}.identity_bindings (
          id UUID PRIMARY KEY,
          identity_id TEXT NOT NULL,
          source TEXT NOT NULL,
          connector_key TEXT NOT NULL,
          external_actor_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE ${quotedSchema}.session_routes (
          id BIGINT PRIMARY KEY,
          session_id TEXT NOT NULL,
          identity_id TEXT,
          channel TEXT NOT NULL,
          connector_key TEXT NOT NULL,
          external_conversation_id TEXT NOT NULL,
          external_actor_id TEXT,
          captured_at_ms BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX runtime_session_routes_lookup_idx
          ON ${quotedSchema}.session_routes (session_id, identity_id, captured_at_ms DESC);
      `);

      const schemaQuery = new SchemaScopedQuery(pool, schema);
      await ensurePostgresIdentitySchema(schemaQuery);
      await ensurePostgresAgentSchema(schemaQuery);
      await ensurePostgresSessionRouteSchema(schemaQuery);
      const indexResult = await pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $1
          AND indexname = ANY($2::text[])
        ORDER BY indexname
      `, [schema, [
        "runtime_agent_pairings_agent_created_idx",
        "runtime_identity_bindings_identity_created_idx",
        "runtime_session_routes_latest_identity_idx",
        "runtime_session_routes_lookup_idx",
      ]]);
      expect(indexResult.rows).toEqual([
        expect.objectContaining({
          indexname: "runtime_agent_pairings_agent_created_idx",
          indexdef: expect.stringContaining("(agent_key, created_at, identity_id)"),
        }),
        expect.objectContaining({
          indexname: "runtime_identity_bindings_identity_created_idx",
          indexdef: expect.stringContaining("(identity_id, created_at, id)"),
        }),
        expect.objectContaining({
          indexname: "runtime_session_routes_latest_identity_idx",
          indexdef: expect.stringContaining("(session_id, identity_id, captured_at_ms DESC, updated_at DESC, id DESC)"),
        }),
      ]);

      const identityIds = Array.from({length: 29}, (_, index) => `identity-${String(index).padStart(2, "0")}`);
      const statuses = identityIds.map((_, index) => index < 2 ? "deleted" : "active");
      await pool.query(`
        INSERT INTO ${quotedSchema}.identities (id, handle, display_name, status)
        SELECT *
        FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
      `, [
        identityIds,
        identityIds.map((_, index) => `person-${String(index).padStart(2, "0")}`),
        identityIds.map((_, index) => index === 3 ? "" : `Person ${index}`),
        statuses,
      ]);
      const pairingTimes = identityIds.map((_, index) => new Date(
        Date.UTC(2026, 0, 1, 0, 0, index === 27 ? 26 : index),
      ));
      await pool.query(`
        INSERT INTO ${quotedSchema}.agent_pairings (agent_key, identity_id, created_at)
        SELECT *
        FROM UNNEST($1::text[], $2::text[], $3::timestamptz[])
      `, [identityIds.map(() => "panda"), identityIds, pairingTimes]);
      await pool.query(`
        INSERT INTO ${quotedSchema}.agent_sessions (id, agent_key)
        VALUES ('session-main', 'panda'), ('session-other', 'panda')
      `);
      await pool.query(`
        INSERT INTO ${quotedSchema}.session_routes (
          id,
          session_id,
          identity_id,
          channel,
          connector_key,
          external_conversation_id,
          external_actor_id,
          captured_at_ms,
          updated_at
        ) VALUES
          (1, 'session-main', 'identity-02', 'telegram', 'bot-old', 'chat-old', 'old-actor', 100, '2026-01-01T00:00:00Z'),
          (2, 'session-main', 'identity-02', 'whatsapp', 'wa-old', 'chat-tie-old', 'tie-old', 200, '2026-01-01T00:00:01Z'),
          (3, 'session-main', 'identity-02', 'email', 'route-main', 'chat-latest', 'route-actor', 200, '2026-01-01T00:00:01Z'),
          (4, 'session-other', 'identity-02', 'discord', 'other-session', 'wrong-chat', 'wrong-actor', 999, '2026-01-01T00:00:02Z')
      `);

      const bindingRows = [
        ...Array.from({length: 5}, (_, index) => ({
          identityId: "identity-02",
          source: `source-${index}`,
          connectorKey: `connector-${index}`,
          actorId: `actor-${index}`,
        })),
        {
          identityId: "identity-02",
          source: "email",
          connectorKey: "route-main",
          actorId: "route-actor",
        },
        {
          identityId: "identity-02",
          source: "signal",
          connectorKey: "signal-main",
          actorId: "signal-actor",
        },
        {
          identityId: "identity-03",
          source: "email",
          connectorKey: "route-main",
          actorId: "other-route-actor",
        },
      ];
      for (const [index, binding] of bindingRows.entries()) {
        await pool.query(`
          INSERT INTO ${quotedSchema}.identity_bindings (
            id,
            identity_id,
            source,
            connector_key,
            external_actor_id,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          binding.identityId,
          binding.source,
          binding.connectorKey,
          binding.actorId,
          new Date(Date.UTC(2026, 0, 2, 0, 0, index)),
        ]);
      }

      const queryable = new SchemaScopedQuery(pool, schema);
      const directory = new PostgresPairedIdentityDirectory({pool: queryable});
      const entries = await directory.listForSession({
        sessionId: "session-main",
        identityLimit: 25,
        bindingLimit: 4,
      });

      expect(queryable.calls).toBe(3);
      expect(entries).toHaveLength(25);
      expect(entries.map((entry) => entry.identityId)).toEqual(identityIds.slice(2, 27));
      expect(entries[0]).toEqual({
        identityId: "identity-02",
        handle: "person-02",
        displayName: "Person 2",
        recentRoute: {
          source: "email",
          connectorKey: "route-main",
          externalConversationId: "chat-latest",
          externalActorId: "route-actor",
        },
        bindings: Array.from({length: 4}, (_, index) => ({
          source: `source-${index}`,
          connectorKey: `connector-${index}`,
          externalActorId: `actor-${index}`,
        })),
        additionalBindingCount: 2,
      });
      expect(entries[1]).toMatchObject({
        identityId: "identity-03",
        displayName: "",
        bindings: [{
          source: "email",
          connectorKey: "route-main",
          externalActorId: "other-route-actor",
        }],
        additionalBindingCount: 0,
      });
    } finally {
      try {
        if (schemaCreated) {
          await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        }
      } finally {
        await pool.end();
      }
    }
  });
});
