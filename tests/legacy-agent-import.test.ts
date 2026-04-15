import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {CredentialCrypto, CredentialService, PostgresCredentialStore,} from "../src/domain/credentials/index.js";
import {importLegacyAgent, planLegacyAgentImport, PostgresAgentStore,} from "../src/domain/agents/index.js";

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
    const credentialStore = new PostgresCredentialStore({pool});
    await pool.query(`CREATE TABLE IF NOT EXISTS thread_runtime_identities (id TEXT PRIMARY KEY)`);
    await agentStore.ensureSchema();
    await credentialStore.ensureSchema();

    return {
      agentStore,
      credentialService: new CredentialService({
        store: credentialStore,
        crypto: new CredentialCrypto("legacy-import-test-key"),
      }),
    };
  }

  it("plans legacy files into Panda storage shapes", async () => {
    const sandbox = await makeTempDir("panda-legacy-plan-");
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
      PANDA_DATA_DIR: path.join(sandbox, ".panda"),
    });

    expect(plan.agentKey).toBe("clawd");
    expect(plan.displayName).toBe("Clawd");
    expect(plan.prompts.map((prompt) => prompt.slug)).toEqual([
      "agent",
      "playbook",
      "heartbeat",
      "soul",
    ]);
    expect(plan.prompts.find((prompt) => prompt.slug === "playbook")?.content).toContain("Legacy agent instructions.");
    expect(plan.memory?.content).toContain("Imported from USER.md");
    expect(plan.memory?.content).toContain("Imported from MEMORY.md");
    expect(plan.diary).toHaveLength(1);
    expect(plan.diary[0]).toMatchObject({
      entryDate: "2026-01-26",
    });
    expect(plan.diary[0]?.content).toContain("Imported from 2026-01-26.md");
    expect(plan.diary[0]?.content).toContain("Extra pricing note.");
    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0]).toMatchObject({
      skillKey: "notion",
      description: "Fast Notion read/write helper.",
    });
    expect(plan.credentials.map((credential) => credential.envKey)).toEqual([
      "NOTION_API_KEY",
      "NOTION_API_VERSION",
    ]);
    expect(plan.warnings.some((warning) => warning.includes("email.pass"))).toBe(true);
  });

  it("imports into Postgres and copies a filtered legacy snapshot", async () => {
    const sandbox = await makeTempDir("panda-legacy-import-");
    const sourceDir = path.join(sandbox, "luna");
    const pandaDataDir = path.join(sandbox, ".panda");
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
    await writeWorkspaceFile(sourceDir, ".git/config", "[core]");
    await writeWorkspaceFile(sourceDir, "node_modules/trash.js", "ignore me");

    const harness = await createHarness();
    const env = {
      ...process.env,
      PANDA_DATA_DIR: pandaDataDir,
    };
    const plan = await planLegacyAgentImport(sourceDir, env);
    const result = await importLegacyAgent(plan, {
      agentStore: harness.agentStore,
      credentialService: harness.credentialService,
      env,
    });

    expect(result).toMatchObject({
      agentKey: "luna",
      createdAgent: true,
      createdMainSession: false,
      promptCount: 4,
      importedMemory: true,
      diaryEntryCount: 1,
      skillCount: 1,
      credentialCount: 1,
      skippedCredentialCount: 0,
    });

    await expect(harness.agentStore.readAgentPrompt("luna", "playbook")).resolves.toMatchObject({
      content: "# AGENTS\nWorkspace rules.",
    });
    await expect(harness.agentStore.readAgentPrompt("luna", "heartbeat")).resolves.toMatchObject({
      content: "# HEARTBEAT\nCheck in twice a day.",
    });
    await expect(harness.agentStore.readAgentPrompt("luna", "soul")).resolves.toMatchObject({
      content: "# SOUL\nWarm but relentless.",
    });
    await expect(harness.agentStore.readAgentDocument("luna", "memory")).resolves.toMatchObject({
      content: expect.stringContaining("Angelina profile."),
    });
    await expect(harness.agentStore.listDiaryEntries("luna")).resolves.toEqual([
      expect.objectContaining({
        entryDate: "2026-02-08",
        content: "Daily recap.",
      }),
    ]);
    await expect(harness.agentStore.listAgentSkills("luna")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "notion",
      }),
    ]);

    const credential = await harness.credentialService.resolveCredential("NOTION_API_KEY", {
      agentKey: "luna",
    });
    expect(credential?.value).toBe("shh");

    const copiedReference = await readFile(path.join(plan.legacyCopyDir, "docs/reference.md"), "utf8");
    expect(copiedReference).toBe("Useful reference.");
    await expect(readFile(path.join(plan.legacyCopyDir, "skills/notion/.env"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(plan.legacyCopyDir, ".git/config"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(plan.legacyCopyDir, "node_modules/trash.js"), "utf8")).rejects.toThrow();
  });
});
