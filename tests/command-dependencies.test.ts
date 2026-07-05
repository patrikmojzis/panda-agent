import {describe, expect, it} from "vitest";

import {
  buildDaemonA2ACommandDependencies,
  buildDaemonChannelCommandDependencies,
  buildRuntimeCommandDependencies,
  buildSubagentCommandDependencies,
} from "../src/app/runtime/command-dependencies.js";
import type {AgentCommandModuleDependencies} from "../src/panda/commands/agent-command-modules.js";

function fakeDependency<K extends keyof AgentCommandModuleDependencies>(
  label: K,
): NonNullable<AgentCommandModuleDependencies[K]> {
  return {label} as NonNullable<AgentCommandModuleDependencies[K]>;
}

describe("command dependency builders", () => {
  it("builds runtime command dependencies with app URL adapters", () => {
    const backgroundJobService = fakeDependency("backgroundJobService");
    const deps = buildRuntimeCommandDependencies({
      env: {
        PANDA_APPS_HOST: "127.0.0.1",
        PANDA_APPS_PORT: "8092",
      },
      backgroundJobService,
      commandFileResolver: fakeDependency("commandFileResolver"),
      watchStore: fakeDependency("watchStore"),
      watchMutations: fakeDependency("watchMutations"),
      scheduledTasks: fakeDependency("scheduledTasks"),
      apps: fakeDependency("apps"),
      appAuth: fakeDependency("appAuth"),
      agentSkills: fakeDependency("agentSkills"),
      sessionPrompts: fakeDependency("sessionPrompts"),
      sessionTodos: fakeDependency("sessionTodos"),
      subagentProfiles: fakeDependency("subagentProfiles"),
      postgresReadonly: fakeDependency("postgresReadonly"),
      executionEnvironments: fakeDependency("executionEnvironments"),
      environmentLifecycle: fakeDependency("environmentLifecycle"),
    });

    expect(deps.backgroundJobService).toBe(backgroundJobService);
    expect(deps.resolveAppLaunchUrls?.({
      agentKey: "panda",
      appSlug: "notes",
      token: "open-token",
    })).toMatchObject({
      appUrl: "http://127.0.0.1:8092/panda/apps/notes/",
      openUrl: "http://127.0.0.1:8092/apps/open?token=open-token",
    });
  });

  it("builds subagent command dependencies only from the subagent session creator", () => {
    const subagentSessions = fakeDependency("subagentSessions");

    expect(buildSubagentCommandDependencies(subagentSessions)).toEqual({
      subagentSessions,
    });
  });

  it("builds daemon channel command dependencies for channel-scoped commands", () => {
    const outboundDeliveries = {
      enqueueDelivery: async () => ({}) as never,
      listDeliveriesForTarget: async () => [],
    };
    const channelActions = {
      enqueueAction: async () => ({}) as never,
    };
    const deps = {
      commandFileResolver: fakeDependency("commandFileResolver"),
      connectorAccounts: fakeDependency("connectorAccounts"),
      conversations: {
        listConversationBindings: async () => [],
      } as NonNullable<AgentCommandModuleDependencies["conversations"]>,
      channelMessages: fakeDependency("channelMessages"),
      outboundDeliveries,
      channelActions,
      email: fakeDependency("email"),
    };
    const built = buildDaemonChannelCommandDependencies(deps);

    expect(built).toMatchObject({
      commandFileResolver: deps.commandFileResolver,
      connectorAccounts: deps.connectorAccounts,
      conversations: deps.conversations,
      channelMessages: deps.channelMessages,
      email: deps.email,
    });
    expect(built.outboundDeliveries).toEqual({
      enqueueDelivery: expect.any(Function),
      listDeliveriesForTarget: expect.any(Function),
      listConversationBindings: expect.any(Function),
    });
    expect(built.channelActions).toEqual({
      enqueueAction: expect.any(Function),
      listConversationBindings: expect.any(Function),
    });
  });

  it("builds daemon A2A command dependencies for Panda-to-Panda commands", () => {
    const deps = {
      commandFileResolver: fakeDependency("commandFileResolver"),
      a2aMessaging: fakeDependency("a2aMessaging"),
      a2aDeliveries: fakeDependency("a2aDeliveries"),
    };

    expect(buildDaemonA2ACommandDependencies(deps)).toEqual(deps);
  });
});
