import {afterEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {PostgresConnectorAccountStore} from "../src/domain/connectors/postgres.js";
import {PostgresWhatsAppRuntimeStatusStore} from "../src/integrations/channels/whatsapp/runtime-status-store.js";

describe("PostgresWhatsAppRuntimeStatusStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  it("persists account-local state and cascades it with the account", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const runtime = new PostgresWhatsAppRuntimeStatusStore({pool});
    await runtime.ensureSchema();
    const agents = new PostgresAgentStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    const accounts = new PostgresConnectorAccountStore({pool});
    const account = await accounts.upsertAccount({
      id: "00000000-0000-4000-8000-000000000001",
      source: "whatsapp",
      accountKey: "main",
      connectorKey: "00000000-0000-4000-8000-000000000001",
      ownerKind: "agent",
      ownerAgentKey: "panda",
      status: "enabled",
    });

    await expect(runtime.setStatus(account.id, "connecting"))
      .resolves.toMatchObject({accountId: account.id, socketState: "connecting"});
    await runtime.heartbeat(account.id);
    await expect(runtime.getStatus(account.id))
      .resolves.toMatchObject({accountId: account.id, socketState: "connecting"});

    await pool.query("DELETE FROM runtime.connector_accounts WHERE id = $1", [account.id]);
    await expect(runtime.getStatus(account.id)).resolves.toBeNull();
  });
});
