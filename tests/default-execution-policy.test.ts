import {describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {RuntimeCommandLeaseService} from "../src/app/runtime/command-leases.js";
import {ExecutionEnvironmentResolver} from "../src/app/runtime/execution-environment-resolver.js";
import {resolveVisibleCommandDescriptors} from "../src/app/runtime/command-visibility.js";
import {defineCommandCatalogModule} from "../src/domain/commands/modules.js";
import type {CommandPolicyDescriptor} from "../src/domain/commands/types.js";
import type {SessionEnvironmentBindingRecord} from "../src/domain/execution-environments/types.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import {createDefaultAgentCommandCatalog} from "../src/panda/commands/agent-command-modules.js";
import {createDefaultExecutionToolPolicy} from "../src/panda/commands/agent-command-policy.js";

function extension(name: string, policy: CommandPolicyDescriptor = {}) {
  return defineCommandCatalogModule({
    descriptor: {name, summary: name, description: name, usage: name, inputModes: ["json"], outputModes: ["json"], arguments: [], examples: []},
    helpArgv: name.split("."),
    policy,
  });
}

const catalog = createDefaultAgentCommandCatalog({extraModules: [
  extension("custom.opted_in", {defaultAllowed: true, capability: "custom.read"}),
  extension("custom.excluded", {defaultAllowed: false}),
  extension("custom.unspecified"),
]});
const defaultToolPolicy = createDefaultExecutionToolPolicy(catalog);
const main = {id: "session-main", agentKey: "panda", kind: "main" as const};

function resolver(binding: SessionEnvironmentBindingRecord | null = null) {
  return new ExecutionEnvironmentResolver({
    defaultToolPolicy,
    env: {BASH_EXECUTION_MODE: "local"},
    store: {
      getDefaultBinding: async () => binding,
      getBindingByAlias: async () => binding,
      getEnvironment: async () => ({id: "env", agentKey: "panda", kind: "local", state: "ready", createdAt: 1, updatedAt: 1}),
    },
  });
}

describe("catalog-owned fallback execution policy", () => {
  it.each([false, undefined])("rejects an extension admitted through an existing capability with eligibility %s", (defaultAllowed) => {
    const conflicting = createDefaultAgentCommandCatalog({extraModules: [
      extension("custom.clock", {defaultAllowed, capability: "time.now", requiresIdentity: true}),
    ]});
    expect(() => createDefaultExecutionToolPolicy(conflicting))
      .toThrow("custom.clock is not opted in, but its capability time.now is granted");
  });

  it("rejects opting into a shared literal-star capability that admits excluded commands", () => {
    const conflicting = createDefaultAgentCommandCatalog({extraModules: [
      extension("custom.mcp_status", {defaultAllowed: true, capability: "mcp.manage.*"}),
    ]});
    expect(() => createDefaultExecutionToolPolicy(conflicting))
      .toThrow("mcp.server.list is not opted in, but its capability mcp.manage.* is granted");
  });

  it("keeps literal-star capability groups distinct under the authority matcher", () => {
    expect(defaultToolPolicy.allowedTools).toContain("mcp.*");
    expect(defaultToolPolicy.allowedTools).not.toContain("mcp.manage.*");
    expect(() => createDefaultExecutionToolPolicy(createDefaultAgentCommandCatalog({extraModules: [
      extension("custom.mcp_read", {capability: "mcp.custom.read"}),
    ]}))).not.toThrow();
  });

  it.each(["main", "branch"] as const)("projects opted-in commands through %s resolution, discovery and lease authority", async (kind) => {
    const session = {...main, kind};
    const environment = await resolver().resolveDefault(session);
    const dispatcher = new RuntimeCommandDispatcher({
      // Model a disabled integration: it remains in the catalog but is not registered.
      commands: catalog.modules.filter((module) => module.descriptor.name !== "discord.voice.status").map(({descriptor}) => ({
        descriptor,
        execute: async () => {throw new Error("Discovery must not execute commands.");},
      })),
    });
    const visible = (await resolveVisibleCommandDescriptors({commandCatalog: catalog, commandExecutor: dispatcher, session, executionEnvironment: environment})).map((descriptor) => descriptor.name);
    expect(visible).toEqual(expect.arrayContaining(["custom.opted_in", "heartbeat.set", "session.compact", "web.fetch", "mcp.call", "subagent.show"]));
    for (const excluded of ["custom.excluded", "custom.unspecified", "web.read", "wiki.overview", "mcp.server.add", "whatsapp.call.send", "discord.voice.status", "postgres.readonly.query", "micro-app.link.create"]) {
      expect(visible).not.toContain(excluded);
    }

    const leases = new RuntimeCommandLeaseService({socketPath: "/tmp/panda-test-command.sock", commandCatalog: catalog});
    const lease = leases.issueCommandLease({...session, sessionId: session.id, toolPolicy: environment.toolPolicy});
    expect(lease).not.toBeNull();
    const scope = await leases.verify(lease!.token);
    expect(scope.allowedCommands).toContain("custom.opted_in");
    expect(scope.allowedCommands).not.toContain("custom.excluded");
    expect(scope.allowedCommands).not.toContain("postgres.readonly.query");
    expect(scope.allowedCommands).not.toContain("env.set");
  });

  it("preserves an explicit binding grant that is excluded from fallback defaults", async () => {
    const toolPolicy = {allowedTools: ["web.read", "custom.excluded"]};
    const environment = await resolver({
      sessionId: main.id, environmentId: "env", alias: "default", isDefault: true,
      credentialPolicy: {mode: "none"}, skillPolicy: {mode: "none"}, toolPolicy,
      createdAt: 1, updatedAt: 1,
    }).resolveDefault(main);
    expect(environment.toolPolicy).toEqual(toolPolicy);
    const leases = new RuntimeCommandLeaseService({socketPath: "/tmp/panda-test-command.sock", commandCatalog: catalog});
    const lease = leases.issueCommandLease({agentKey: main.agentKey, sessionId: main.id, toolPolicy: environment.toolPolicy});
    await expect(leases.verify(lease!.token)).resolves.toMatchObject({allowedCommands: ["web.read", "custom.excluded"]});
  });

  it("keeps immutable subagent grants independent of the main-session policy", async () => {
    const toolPolicy = {allowedTools: ["web.read"]};
    const metadata = buildSubagentSessionMetadata({
      role: "reader", task: "Read one page", parentSessionId: main.id, execution: "agent_workspace",
      profile: {slug: "reader", source: "ad_hoc", description: "Reader", prompt: "Read", toolGroups: ["core"], transcriptMode: "none"},
      resolved: {credentialPolicy: {mode: "none"}, skillPolicy: {mode: "none"}, toolPolicy},
    });
    const environment = await resolver().resolveDefault({...main, id: "session-child", kind: "subagent", metadata});
    expect(environment.toolPolicy).toEqual(toolPolicy);
    expect(environment.toolPolicy.allowedTools).not.toContain("custom.read");
    expect(environment.toolPolicy.allowedTools).not.toContain("heartbeat.set");
  });
});
