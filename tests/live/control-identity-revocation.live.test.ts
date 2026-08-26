import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresControlAuthService} from "../../src/domain/control/auth.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("Control identity revocation migration with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/control-identity-revocation-live-test",
      max: 4,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt("revokes legacy access before a deleted identity can be reactivated", async () => {
    const migrator = (count: number) => createPostgresMigrator({
      pool,
      migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
      schemaName: "runtime",
      tableName: "schema_migrations",
      lockName: "panda:control-identity-revocation-live-test",
    });
    await migrator(PANDA_SCHEMA_MIGRATIONS.length - 1).migrate();

    const identities = new PostgresIdentityStore({pool});
    const auth = new PostgresControlAuthService({pool});
    await identities.createIdentity({
      id: "identity-legacy-control-admin",
      handle: "legacy-control-admin",
      displayName: "Legacy Control Admin",
    });
    const grant = await auth.createGrant({
      identityId: "identity-legacy-control-admin",
      role: "admin",
    });
    const login = await auth.loginWithToken(grant.loginToken, {remember: true});
    await identities.updateIdentity({
      identityId: "identity-legacy-control-admin",
      status: "deleted",
    });

    await migrator(PANDA_SCHEMA_MIGRATIONS.length).migrate();
    await expect(pool.query(`
      SELECT active
      FROM "runtime"."control_grants"
      WHERE id = $1
    `, [grant.grant.id])).resolves.toMatchObject({rows: [{active: false}]});
    await expect(pool.query(`
      SELECT revoked_at IS NOT NULL AS revoked
      FROM "runtime"."control_sessions"
      WHERE id = $1
    `, [login.session.id])).resolves.toMatchObject({rows: [{revoked: true}]});

    await identities.updateIdentity({
      identityId: "identity-legacy-control-admin",
      status: "active",
    });
    await expect(auth.getSessionByToken(login.sessionToken)).resolves.toBeNull();
    await expect(migrator(PANDA_SCHEMA_MIGRATIONS.length).migrate()).resolves.toMatchObject({
      current: true,
      applied: expect.any(Array),
    });
  });
});
