import {ensurePostgresAgentSchema} from "../../src/domain/agents/postgres-schema.js";
import {ensurePostgresGatewaySchema} from "../../src/domain/gateway/postgres-schema.js";
import {ensurePostgresIdentitySchema} from "../../src/domain/identity/postgres-schema.js";
import {ensurePostgresSessionSchema} from "../../src/domain/sessions/postgres-schema.js";
import {ensurePostgresThreadRuntimeSchema} from "../../src/domain/threads/runtime/postgres-schema.js";
import type {PgQueryable} from "../../src/lib/postgres-query.js";

export async function installGatewayTestSchema(pool: PgQueryable): Promise<void> {
  await ensurePostgresIdentitySchema(pool);
  await ensurePostgresAgentSchema(pool);
  await ensurePostgresSessionSchema(pool);
  await ensurePostgresThreadRuntimeSchema(pool);
  await ensurePostgresGatewaySchema(pool);
}
