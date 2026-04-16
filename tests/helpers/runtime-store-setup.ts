import {ensureSchemas} from "../../src/app/runtime/postgres-bootstrap.js";
import {PostgresIdentityStore} from "../../src/domain/identity/index.js";
import {PostgresSessionStore} from "../../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/index.js";

export async function createRuntimeStores(pool: {
  connect(): Promise<any>;
  query(text: string, values?: readonly unknown[]): Promise<any>;
}) {
  const identityStore = new PostgresIdentityStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool});

  await ensureSchemas([
    identityStore,
    sessionStore,
    threadStore,
  ]);

  return {
    identityStore,
    sessionStore,
    threadStore,
  };
}
