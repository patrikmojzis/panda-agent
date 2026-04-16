import {mkdtemp, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {resolveAgentDir} from "../src/app/runtime/data-dir.js";
import {ensureAgent, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";

describe("ensureAgent", () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }

    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
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
    const threadStore = new PostgresThreadRuntimeStore({pool});

    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sessionStore.ensureSchema();
    await threadStore.ensureSchema();

    const dataDir = await mkdtemp(path.join(os.tmpdir(), "panda-agent-ensure-"));
    directories.push(dataDir);

    return {
      pool,
      agentStore,
      sessionStore,
      threadStore,
      env: {
        DATA_DIR: dataDir,
      },
    };
  }

  it("creates a missing agent plus its main session, thread, and home", async () => {
    const {agentStore, sessionStore, threadStore, env} = await createStores();

    const result = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      "Luna",
      {name: "Luna", env},
    );

    expect(result).toMatchObject({
      agentKey: "luna",
      displayName: "Luna",
      createdAgent: true,
      createdMainSession: true,
      createdMainThread: true,
    });
    await expect(agentStore.getAgent("luna")).resolves.toMatchObject({
      agentKey: "luna",
      displayName: "Luna",
    });
    await expect(sessionStore.getMainSession("luna")).resolves.toMatchObject({
      id: result.sessionId,
      currentThreadId: result.threadId,
    });
    await expect(threadStore.getThread(result.threadId)).resolves.toMatchObject({
      id: result.threadId,
      sessionId: result.sessionId,
      context: {
        agentKey: "luna",
        sessionId: result.sessionId,
        cwd: resolveAgentDir("luna", env),
      },
    });
    expect((await stat(result.homeDir)).isDirectory()).toBe(true);
  });

  it("does nothing on a healthy existing agent", async () => {
    const {agentStore, sessionStore, threadStore, env} = await createStores();

    const first = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      "claw",
      {env},
    );
    const second = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      "claw",
      {env},
    );

    expect(second).toMatchObject({
      agentKey: "claw",
      createdAgent: false,
      createdMainSession: false,
      createdMainThread: false,
      sessionId: first.sessionId,
      threadId: first.threadId,
    });
  });

  it("repairs missing main session, missing thread, and missing home without recreating the agent", async () => {
    const {pool, agentStore, sessionStore, threadStore, env} = await createStores();

    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
    });

    const afterMissingSession = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      "ops",
      {env},
    );
    expect(afterMissingSession).toMatchObject({
      agentKey: "ops",
      createdAgent: false,
      createdMainSession: true,
      createdMainThread: true,
    });

    await pool.query("DELETE FROM runtime.threads WHERE id = $1", [afterMissingSession.threadId]);
    await rm(afterMissingSession.homeDir, {recursive: true, force: true});

    const repaired = await ensureAgent(
      {agentStore, sessionStore, threadStore},
      "ops",
      {env},
    );
    expect(repaired).toMatchObject({
      agentKey: "ops",
      createdAgent: false,
      createdMainSession: false,
      createdMainThread: true,
      sessionId: afterMissingSession.sessionId,
    });
    expect(repaired.threadId).not.toBe(afterMissingSession.threadId);
    await expect(threadStore.getThread(repaired.threadId)).resolves.toMatchObject({
      id: repaired.threadId,
      sessionId: repaired.sessionId,
    });
    expect((await stat(repaired.homeDir)).isDirectory()).toBe(true);
  });
});
