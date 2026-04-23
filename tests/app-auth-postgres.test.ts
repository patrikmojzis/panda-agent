import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentAppAuthService} from "../src/domain/apps/auth.js";
import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";

describe("PostgresAgentAppAuthService", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createStores() {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const auth = new PostgresAgentAppAuthService({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sessionStore.ensureSchema();
    await auth.ensureSchema();

    await identityStore.createIdentity({
      id: "identity-patrik",
      handle: "patrik",
      displayName: "Patrik",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await sessionStore.createSessionRecord({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-main",
      createdByIdentityId: "identity-patrik",
    });

    return {auth};
  }

  it("redeems one-time launch tokens into app-scoped sessions", async () => {
    const {auth} = await createStores();
    const launch = await auth.createLaunchToken({
      agentKey: "panda",
      appSlug: "period-tracker",
      identityId: "identity-patrik",
      sessionId: "session-main",
      expiresInMs: 60_000,
    });

    const redeemed = await auth.redeemLaunchToken(launch.token, {
      sessionTtlMs: 60_000,
    });
    expect(redeemed.session).toMatchObject({
      agentKey: "panda",
      appSlug: "period-tracker",
      identityId: "identity-patrik",
      sessionId: "session-main",
    });
    expect(auth.verifyCsrfToken(redeemed.session, redeemed.csrfToken)).toBe(true);
    await expect(auth.getSessionByToken(redeemed.sessionToken)).resolves.toMatchObject({
      id: redeemed.session.id,
    });
    await expect(auth.redeemLaunchToken(launch.token)).rejects.toThrow("already used");
  });
});
