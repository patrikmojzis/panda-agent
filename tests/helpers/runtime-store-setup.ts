import {ensureSchemas} from "../../src/app/runtime/postgres-bootstrap.js";
import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../../src/domain/identity/index.js";
import {PostgresEmailStore} from "../../src/domain/email/index.js";
import {PostgresSessionStore} from "../../src/domain/sessions/index.js";
import {PostgresSidecarRepo} from "../../src/domain/sidecars/index.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/index.js";

export async function createRuntimeStores(pool: {
  connect(): Promise<any>;
  query(text: string, values?: readonly unknown[]): Promise<any>;
}) {
  const identityStore = new PostgresIdentityStore({pool});
  const agentStore = new PostgresAgentStore({pool});
  const sessionStore = new PostgresSessionStore({pool});
  const sidecarRepo = new PostgresSidecarRepo({pool});
  const threadStore = new PostgresThreadRuntimeStore({pool});
  const emailStore = new PostgresEmailStore({pool});

  await ensureSchemas([
    identityStore,
    agentStore,
    sidecarRepo,
    sessionStore,
    threadStore,
    emailStore,
  ]);
  await agentStore.bootstrapAgent({
    agentKey: "panda",
    displayName: "Panda",
    prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
  });

  return {
    agentStore,
    identityStore,
    sessionStore,
    sidecarRepo,
    threadStore,
    emailStore,
  };
}
