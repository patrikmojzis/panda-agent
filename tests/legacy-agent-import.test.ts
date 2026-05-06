import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {CredentialCrypto, CredentialService, PostgresCredentialStore,} from "../src/domain/credentials/index.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {importLegacyAgent, planLegacyAgentImport,} from "../src/domain/agents/legacy-import.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

describe("legacy agent import", () => {
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

  async function makeTempDir(prefix: string): Promise<string> {
    const {mkdtemp} = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
    const targetPath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(targetPath), {recursive: true});
    await writeFile(targetPath, content, "utf8");
  }

  async function createHarness() {
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

    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const threadStore = new TestThreadRuntimeStore();
    const credentialStore = new PostgresCredentialStore({pool});
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS runtime;
      CREATE TABLE IF NOT EXISTS runtime.identities (
        id TEXT PRIMARY KEY,
        handle TEXT
      )
    `);
    await agentStore.ensureSchema();
    await sessionStore.ensureSchema();
    await credentialStore.ensureSchema();

    return {
      agentStore,
      sessionStore,
      threadStore,
      createIdentity: async (identity: {id: string; handle: string}) => {
        await pool.query(
          "INSERT INTO runtime.identities (id, handle) VALUES ($1, $2)",
          [identity.id, identity.handle],
        );
        return identity;
      },
      credentialService: new CredentialService({
        store: credentialStore,
        crypto: new CredentialCrypto("legacy-import-test-key"),
      }),
    };
  }

  it("plans legacy files into Panda storage shapes", async () => {
    const sandbox = await makeTempDir("runtime-legacy-plan-");
    const sourceDir = path.join(sandbox, "clawd");
    await mkdir(sourceDir, {recursive: true});

    await writeWorkspaceFile(sourceDir, "AGENTS.md", "# AGENTS\nLegacy agent instructions.");
    await writeWorkspaceFile(sourceDir, "HEARTBEAT.md", "# HEARTBEAT\nDo a useful thing.");
    await writeWorkspaceFile(sourceDir, "SOUL.md", "# SOUL\nHave a point of view.");
    await writeWorkspaceFile(sourceDir, "USER.md", "# USER\nPatrik profile.");
    await writeWorkspaceFile(sourceDir, "MEMORY.md", "# MEMORY\nLong-term notes.");
    await writeWorkspaceFile(sourceDir, "memory/2026-01-26.md", "Main diary entry.");
    await writeWorkspaceFile(sourceDir, "memory/2026-01-26-gemini-pricing.md", "Extra pricing note.");
    await writeWorkspaceFile(sourceDir, "memory/internal-stream-latest.md", "Not a diary file.");
    await writeWorkspaceFile(sourceDir, "skills/notion/SKILL.md", [
      "---",
      "name: notion-panda",
      "description: Fast Notion read/write helper.",
      "---",
      "",
      "# Notion",
      "",
      "Skill body.",
    ].join("\n"));
    await writeWorkspaceFile(sourceDir, "skills/notion/.env", [
      "NOTION_API_KEY=secret-key",
      "NOTION_API_VERSION=2022-06-28",
    ].join("\n"));
    await writeWorkspaceFile(sourceDir, "skills/lunomedic/email.pass", "super-secret");

    const plan = await planLegacyAgentImport(sourceDir, {
      ...process.env,
      DATA_DIR: path.join(sandbox, ".panda"),
    });

    expect(plan.agentKey).toBe("clawd");
    expect(plan.displayName).toBe("Clawd");
    expect(plan.prompts.map((prompt) => prompt.slug)).toEqual([
      "agent",
      "heartbeat",
    ]);
    expect(plan.prompts[0]?.content).toContain("Imported from SOUL.md");
    expect(plan.prompts[0]?.content).toContain("# SOUL\nHave a point of view.");
    expect(plan.messages).toEqual([]);
    expect(plan.messageImportIncluded).toBe(false);
    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0]).toMatchObject({
      skillKey: "notion",
      description: "Fast Notion read/write helper.",
    });
    expect(plan.credentials.map((credential) => credential.envKey)).toEqual([
      "NOTION_API_KEY",
      "NOTION_API_VERSION",
    ]);
    expect(plan.warnings.some((warning) => warning.includes("Skipped legacy memory import from USER.md + MEMORY.md"))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes("Skipped 3 legacy markdown files from memory/"))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes("email.pass"))).toBe(true);
  });

  it("imports credentials and legacy messages while skipping legacy memory files", async () => {
    const sandbox = await makeTempDir("runtime-legacy-import-");
    const sourceDir = path.join(sandbox, "luna");
    const dataDir = path.join(sandbox, ".panda");
    await mkdir(sourceDir, {recursive: true});

    await writeWorkspaceFile(sourceDir, "AGENTS.md", "# AGENTS\nWorkspace rules.");
    await writeWorkspaceFile(sourceDir, "HEARTBEAT.md", "# HEARTBEAT\nCheck in twice a day.");
    await writeWorkspaceFile(sourceDir, "SOUL.md", "# SOUL\nWarm but relentless.");
    await writeWorkspaceFile(sourceDir, "USER.md", "# USER\nAngelina profile.");
    await writeWorkspaceFile(sourceDir, "MEMORY.md", "# MEMORY\nCurated notes.");
    await writeWorkspaceFile(sourceDir, "memory/2026-02-08.md", "Daily recap.");
    await writeWorkspaceFile(sourceDir, "skills/notion/SKILL.md", [
      "# Notion",
      "",
      "Use this when working with Notion pages quickly.",
    ].join("\n"));
    await writeWorkspaceFile(sourceDir, "skills/notion/.env", "NOTION_API_KEY=shh");
    await writeWorkspaceFile(sourceDir, "docs/reference.md", "Useful reference.");
    await writeWorkspaceFile(sourceDir, ".openclaw-placeholder", "ignored");
    await writeWorkspaceFile(sourceDir, ".git/config", "[core]");
    await writeWorkspaceFile(sourceDir, "node_modules/trash.js", "ignore me");
    await writeWorkspaceFile(path.join(sandbox, ".openclaw", "agents", "luna"), "sessions/11111111-1111-1111-1111-111111111111.jsonl", [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "legacy-session-1",
        timestamp: "2026-02-08T22:45:18.551Z",
        cwd: "/root",
      }),
      JSON.stringify({
        type: "message",
        id: "legacy-user-1",
        timestamp: "2026-02-08T22:45:34.499Z",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "[Telegram Anhelina (@angelinakozinska) id:2009588507 +7s 2026-02-08 22:45 UTC] Privit\n[message_id: 2107]",
          }],
          timestamp: 1770590734491,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "legacy-assistant-1",
        timestamp: "2026-02-08T22:45:40.675Z",
        message: {
          role: "assistant",
          content: [
            {type: "thinking", thinking: "warm reply"},
            {type: "text", text: "Привіт, Ангеліно!"},
          ],
          timestamp: 1770590740675,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "legacy-user-cron",
        timestamp: "2026-02-08T23:00:00.000Z",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "[cron:123 internal] Read and follow /root/luna/skills/subconscious.md",
          }],
          timestamp: 1770591600000,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "legacy-assistant-cron",
        timestamp: "2026-02-08T23:00:10.000Z",
        message: {
          role: "assistant",
          content: [{type: "text", text: "NO_REPLY"}],
          timestamp: 1770591610000,
        },
      }),
    ].join("\n"));

    const harness = await createHarness();
    const identity = await harness.createIdentity({
      id: "patrik-id",
      handle: "patrik",
    });
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
    };
    const plan = await planLegacyAgentImport(sourceDir, {
      env,
      includeMessages: true,
    });
    const result = await importLegacyAgent(plan, {
      agentStore: harness.agentStore,
      credentialService: harness.credentialService,
      identityId: identity.id,
      includeMessages: true,
      sessionStore: harness.sessionStore,
      threadStore: harness.threadStore,
      env,
    });

    expect(result).toMatchObject({
      agentKey: "luna",
      createdAgent: true,
      createdMainSession: true,
      identityId: "patrik-id",
      promptCount: 2,
      messageCount: 2,
      skillCount: 1,
      credentialCount: 1,
      skippedCredentialCount: 0,
    });
    expect(plan.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Privit",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "Привіт, Ангеліно!",
      }),
    ]);

    await expect(harness.agentStore.readAgentPrompt("luna", "agent")).resolves.toMatchObject({
      content: expect.stringContaining("# SOUL\nWarm but relentless."),
    });
    await expect(harness.agentStore.readAgentPrompt("luna", "heartbeat")).resolves.toMatchObject({
      content: "# HEARTBEAT\nCheck in twice a day.",
    });
    await expect(harness.agentStore.listAgentSkills("luna")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "notion",
      }),
    ]);
    await expect(harness.agentStore.listAgentPairings("luna")).resolves.toEqual([
      expect.objectContaining({
        identityId: identity.id,
      }),
    ]);

    const credential = await harness.credentialService.resolveCredential("NOTION_API_KEY", {
      agentKey: "luna",
    });
    expect(credential?.value).toBe("shh");

    const session = await harness.sessionStore.getMainSession("luna");
    expect(session).toMatchObject({
      createdByIdentityId: identity.id,
    });
    expect(session).not.toBeNull();
    const transcript = await harness.threadStore.loadTranscript(session!.currentThreadId);
    expect(transcript).toMatchObject([
      {
        origin: "input",
        source: "legacy_import",
        identityId: identity.id,
        createdAt: 1770590734491,
        message: {
          role: "user",
          content: "Privit",
        },
      },
      {
        origin: "runtime",
        source: "legacy_import",
        identityId: undefined,
        createdAt: 1770590740675,
        message: {
          role: "assistant",
          content: [{type: "text", text: "Привіт, Ангеліно!"}],
        },
      },
    ]);
    expect(result.warnings.some((warning) => warning.includes("Skipped legacy memory import"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Skipped 1 legacy markdown files from memory/"))).toBe(true);

    const copiedReference = await readFile(path.join(plan.legacyCopyDir, "docs/reference.md"), "utf8");
    expect(copiedReference).toBe("Useful reference.");
    await expect(readFile(path.join(plan.legacyCopyDir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(plan.legacyCopyDir, "skills/notion/.env"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(plan.legacyCopyDir, ".git/config"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(plan.legacyCopyDir, "node_modules/trash.js"), "utf8")).rejects.toThrow();
  });
});
