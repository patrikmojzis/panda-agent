import {PostgresAgentStore} from "../../src/domain/agents/index.js";
import {ensurePostgresAgentSchema} from "../../src/domain/agents/postgres-schema.js";
import {PostgresIdentityStore} from "../../src/domain/identity/index.js";
import {ensurePostgresIdentitySchema} from "../../src/domain/identity/postgres-schema.js";
import {PostgresEmailStore} from "../../src/domain/email/postgres.js";
import {ensurePostgresEmailSchema} from "../../src/domain/email/postgres-schema.js";
import {PostgresSessionStore} from "../../src/domain/sessions/index.js";
import {ensurePostgresSessionSchema} from "../../src/domain/sessions/postgres-schema.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/index.js";
import {ensurePostgresThreadRuntimeSchema} from "../../src/domain/threads/runtime/postgres-schema.js";

export async function createRuntimeStores(pool: {
  connect(): Promise<any>;
  query(text: string, values?: readonly unknown[]): Promise<any>;
}) {
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool});
  const emailStore = new PostgresEmailStore({pool});

  await ensurePostgresIdentitySchema(pool);
  await ensurePostgresAgentSchema(pool);
  await ensurePostgresSessionSchema(pool);
  await ensurePostgresThreadRuntimeSchema(pool);
  await ensurePostgresEmailSchema(pool);
  await agentStore.bootstrapAgent({
    agentKey: "panda",
    displayName: "Panda",
  });

  return {
    agentStore,
    identityStore,
    sessionStore,
    threadStore,
    emailStore,
  };
}
