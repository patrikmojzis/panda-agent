import {afterEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";

import {PostgresConnectorAccountStore} from "../src/domain/connectors/postgres.js";
import {ensurePostgresConnectorAccountSchema} from "../src/domain/connectors/postgres-schema.js";
import {PostgresIdentityStore} from "../src/domain/identity/postgres.js";
import {ensurePostgresWhatsAppAuthSchema} from "../src/integrations/channels/whatsapp/auth-schema.js";

describe("WhatsApp auth schema hard cut", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  it("removes legacy auth and WhatsApp bindings exactly once", async () => {
    const db = newDb({noAstCoverageCheck: true});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    await ensurePostgresConnectorAccountSchema(pool);
    const accounts = new PostgresConnectorAccountStore({pool});
    const identities = new PostgresIdentityStore({pool});
    const identity = await identities.createIdentity({
      id: "identity-owner",
      handle: "owner",
      displayName: "Owner",
    });
    const legacy = await accounts.upsertAccount({
      id: "00000000-0000-4000-8000-000000000001",
      source: "whatsapp",
      accountKey: "main",
      connectorKey: "main",
      status: "enabled",
    });
    await identities.ensureIdentityBinding({
      source: "whatsapp",
      connectorKey: legacy.connectorKey,
      externalActorId: "246664333885442@lid",
      identityId: identity.id,
    });
    await pool.query(`
      CREATE TABLE "runtime"."conversation_sessions" (
        source TEXT NOT NULL,
        connector_key TEXT NOT NULL
      )
    `);
    await pool.query(`
      INSERT INTO "runtime"."conversation_sessions" (source, connector_key)
      VALUES ('whatsapp', 'main')
    `);
    await pool.query(`CREATE TABLE "runtime"."whatsapp_auth_creds" (connector_key TEXT)`);
    await pool.query(`CREATE TABLE "runtime"."whatsapp_auth_keys" (connector_key TEXT)`);
    await pool.query(`INSERT INTO "runtime"."whatsapp_auth_creds" VALUES ('main')`);
    await pool.query(`INSERT INTO "runtime"."whatsapp_auth_keys" VALUES ('main')`);

    await ensurePostgresWhatsAppAuthSchema(pool);

    const oldTables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'runtime'
        AND table_name IN ('whatsapp_auth_creds', 'whatsapp_auth_keys')
    `);
    expect(oldTables.rows).toEqual([]);
    await expect(accounts.getAccountByKey("whatsapp", "main")).resolves.toBeNull();
    await expect(identities.resolveIdentityBinding({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "246664333885442@lid",
    })).resolves.toBeNull();
    await expect(pool.query(`SELECT COUNT(*)::int AS count FROM "runtime"."conversation_sessions" WHERE source = 'whatsapp'`))
      .resolves.toMatchObject({rows: [{count: 0}]});

    const replacement = await accounts.upsertAccount({
      id: "00000000-0000-4000-8000-000000000002",
      source: "whatsapp",
      accountKey: "replacement",
      connectorKey: "00000000-0000-4000-8000-000000000002",
      status: "disabled",
    });
    await ensurePostgresWhatsAppAuthSchema(pool);
    await expect(accounts.getAccountByKey("whatsapp", "replacement"))
      .resolves.toMatchObject({id: replacement.id});
  });
});
