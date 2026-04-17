import {ensureSchemas} from "../../src/app/runtime/postgres-bootstrap.js";
import {PostgresAgentStore} from "../../src/domain/agents/index.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES} from "../../src/domain/agents/templates.js";
import {PostgresIdentityStore} from "../../src/domain/identity/index.js";
import {PostgresSessionStore} from "../../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/index.js";

export async function createRuntimeStores(pool: {
  connect(): Promise<any>;
  query(text: string, values?: readonly unknown[]): Promise<any>;
}) {
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool});

  await ensureSchemas([
    identityStore,
    agentStore,
    sessionStore,
    threadStore,
  ]);
  await agentStore.bootstrapAgent({
    agentKey: "panda",
    displayName: "Panda",
    prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
  });

  return {
    agentStore,
    identityStore,
    sessionStore,
    threadStore,
  };
}
