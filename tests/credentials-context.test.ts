import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {createThreadDefinition} from "../src/app/runtime/thread-definition.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {ensurePostgresAgentTableSchema} from "../src/domain/agents/postgres-schema.js";
import {PostgresCredentialStore} from "../src/domain/credentials/postgres.js";
import {ensurePostgresCredentialSchema} from "../src/domain/credentials/postgres-schema.js";
import {CredentialResolver, CredentialService} from "../src/domain/credentials/resolver.js";
import type {ExecutionCredentialPolicy, ResolvedExecutionEnvironment} from "../src/domain/execution-environments/types.js";
import {SecretCrypto} from "../src/domain/secrets/crypto.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import {gatherContexts} from "../src/kernel/agent/llm-context.js";
import {buildDefaultAgentLlmContexts} from "../src/panda/contexts/builder.js";
import {CredentialsContext} from "../src/panda/contexts/credentials-context.js";

const baseContext: DefaultAgentSessionContext = {
  agentKey: "panda",
  sessionId: "session-main",
  threadId: "thread-main",
  cwd: "/workspace",
};

function createEnvironment(credentialPolicy: ExecutionCredentialPolicy): ResolvedExecutionEnvironment {
  return {
    id: "local:panda",
    agentKey: "panda",
    kind: "local",
    state: "ready",
    executionMode: "local",
    credentialPolicy,
    skillPolicy: {mode: "all_agent"},
    toolPolicy: {allowedTools: ["bash"]},
    source: "fallback",
  };
}

describe("CredentialsContext", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

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
    await ensurePostgresAgentTableSchema(pool);
    await ensurePostgresCredentialSchema(pool);
    const agents = new PostgresAgentStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await agents.bootstrapAgent({agentKey: "ops", displayName: "Ops"});
    const store = new PostgresCredentialStore({pool});
    const service = new CredentialService({store, crypto: new SecretCrypto("context-test-master-key")});
    const credentials = new CredentialResolver({store});
    await service.setCredential({agentKey: "panda", envKey: "ZENDESK_TOKEN", value: "zendesk-secret-value"});
    await service.setCredential({agentKey: "panda", envKey: "GITHUB_TOKEN", value: "github-secret-value"});
    await service.setCredential({agentKey: "ops", envKey: "OPS_ONLY_TOKEN", value: "ops-secret-value"});
    return {credentials, service};
  }

  it("shows sorted names for the owning agent without needing a decryption key", async () => {
    const {credentials} = await createHarness();
    await expect(credentials.listCredentialNames({agentKey: "panda"})).resolves.toEqual([
      "GITHUB_TOKEN",
      "ZENDESK_TOKEN",
    ]);
    const context = new CredentialsContext({credentials, agentKey: "panda"});

    const content = await context.getContent();

    expect(content).toContain("default bash target");
    expect(content).toContain("- GITHUB_TOKEN\n- ZENDESK_TOKEN");
    expect(content).toContain("shell environment expansion");
    expect(content).not.toContain("OPS_ONLY_TOKEN");
    expect(content).not.toContain("github-secret-value");
    expect(content).not.toContain("zendesk-secret-value");
    expect(content).not.toContain("ops-secret-value");
  });

  it("refreshes the inventory after credentials are added or removed", async () => {
    const {credentials, service} = await createHarness();
    const context = new CredentialsContext({credentials, agentKey: "panda"});
    expect(await context.getContent()).not.toContain("NOTION_API_KEY");

    await service.setCredential({agentKey: "panda", envKey: "NOTION_API_KEY", value: "notion-secret-value"});
    await service.clearCredential({agentKey: "panda", envKey: "GITHUB_TOKEN"});

    const content = await context.getContent();
    expect(content).toContain("NOTION_API_KEY");
    expect(content).not.toContain("GITHUB_TOKEN");
    expect(content).not.toContain("notion-secret-value");
  });

  it("shows only stored env names in the exact execution allowlist", async () => {
    const {credentials} = await createHarness();
    const context = new CredentialsContext({
      credentials,
      agentKey: "panda",
      credentialPolicy: {
        mode: "allowlist",
        envKeys: ["GITHUB_TOKEN", "zendesk_token", "MISSING_TOKEN", "OPS_ONLY_TOKEN"],
        credentialRefs: ["mcp-oauth:reports"],
      },
    });

    const content = await context.getContent();

    expect(content).toContain("GITHUB_TOKEN");
    expect(content).not.toContain("ZENDESK_TOKEN");
    expect(content).not.toContain("MISSING_TOKEN");
    expect(content).not.toContain("OPS_ONLY_TOKEN");
    expect(content).not.toContain("mcp-oauth:reports");
  });

  it("reports no available credentials when the execution policy denies them", async () => {
    const {credentials} = await createHarness();
    const context = new CredentialsContext({credentials, agentKey: "panda", credentialPolicy: {mode: "none"}});

    const content = await context.getContent();

    expect(content).toContain("(none)");
    expect(content).not.toContain("GITHUB_TOKEN");
    expect(content).not.toContain("ZENDESK_TOKEN");
  });

  it("includes credential names in the default context selection", async () => {
    const {credentials} = await createHarness();
    const contexts = buildDefaultAgentLlmContexts({
      context: baseContext,
      agentKey: "panda",
      credentials,
    });

    const content = await gatherContexts(contexts);

    expect(content).toContain("**Available Credentials:**");
    expect(content).toContain("GITHUB_TOKEN");
    expect(content).toContain("ZENDESK_TOKEN");
  });

  it("does not expose the parent inventory to a subagent without an execution policy", async () => {
    const {credentials} = await createHarness();
    const contexts = buildDefaultAgentLlmContexts({
      context: {...baseContext, sessionKind: "subagent"},
      agentKey: "panda",
      credentials,
      sections: ["credentials"],
    });

    const content = await gatherContexts(contexts);

    expect(content).toContain("**Available Credentials:**");
    expect(content).toContain("(none)");
    expect(content).not.toContain("GITHUB_TOKEN");
    expect(content).not.toContain("ZENDESK_TOKEN");
  });

  it.each(["main", "subagent"] as const)("wires scoped credentials into %s thread definitions", async (kind) => {
    const {credentials} = await createHarness();
    const credentialPolicy: ExecutionCredentialPolicy = {mode: "allowlist", envKeys: ["GITHUB_TOKEN"]};
    const metadata = kind === "subagent" ? buildSubagentSessionMetadata({
      role: "workspace",
      task: "Inspect GitHub issues.",
      parentSessionId: "parent-session",
      execution: "agent_workspace",
      profile: {
        slug: "workspace",
        source: "builtin",
        description: "Workspace reader.",
        prompt: "Inspect the requested repository.",
        toolGroups: ["core"],
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy,
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {allowedTools: ["bash"]},
      },
    }) : {};
    const definition = createThreadDefinition({
      thread: {id: "thread-credentials", sessionId: "session-credentials", createdAt: 1, updatedAt: 1},
      session: {id: "session-credentials", agentKey: "panda", kind, metadata},
      fallbackContext: {cwd: "/workspace"},
      credentials,
      executionEnvironment: createEnvironment(credentialPolicy),
      tools: [],
    });

    const content = await gatherContexts(definition.llmContexts ?? []);

    expect(content).toContain("**Available Credentials:**");
    expect(content).toContain("GITHUB_TOKEN");
    expect(content).not.toContain("ZENDESK_TOKEN");
    expect(content).not.toContain("OPS_ONLY_TOKEN");
    expect(content).not.toContain("github-secret-value");
  });
});
