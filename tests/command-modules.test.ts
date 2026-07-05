import {describe, expect, it} from "vitest";

import {
  commandDescriptorsFromModules,
  commandNamesForRegistrationPhase,
  commandRoutesFromModules,
  combineCommandModules,
  createCommandCatalog,
  createCommandsFromModules,
  defineCommandCatalogModule,
  defineCommandModule,
} from "../src/domain/commands/modules.js";
import type {CommandCatalogModule, CommandModule, RegisteredCommand} from "../src/domain/commands/types.js";
import {
  type AgentCommandModuleDependencies,
  buildDefaultAgentCommandModules,
  createDefaultAgentCommandCatalog,
  DEFAULT_AGENT_COMMAND_CATALOG,
  DEFAULT_AGENT_COMMAND_MODULES,
} from "../src/panda/commands/agent-command-modules.js";
import {agentCommandPolicy} from "../src/panda/commands/agent-command-policy.js";

const factoryBackedCommandNames = [
  "time.now",
  "watch.list",
  "watch.show",
  "watch.runs",
  "watch.create",
  "watch.update",
  "watch.disable",
  "schedule.list",
  "schedule.show",
  "schedule.runs",
  "schedule.create",
  "schedule.update",
  "schedule.cancel",
  "micro-app.check",
  "micro-app.create",
  "micro-app.link.create",
  "micro-app.list",
  "micro-app.view",
  "micro-app.action",
  "environment.create",
  "environment.list",
  "environment.show",
  "environment.stop",
  "environment.logs",
  "skill.list",
  "skill.show",
  "skill.load",
  "skill.set",
  "skill.patch",
  "skill.delete",
  "postgres.readonly.query",
  "wiki.read",
  "wiki.search",
  "wiki.list",
  "wiki.diff",
  "wiki.write",
  "wiki.write.section",
  "wiki.move",
  "wiki.archive",
  "wiki.restore",
  "wiki.attach.image",
  "wiki.fetch.asset",
  "wiki.delete.asset",
  "session.prompt.read",
  "session.prompt.set",
  "session.prompt.transform",
  "todo.add",
  "todo.list",
  "todo.show",
  "todo.done",
  "todo.block",
  "todo.clear",
  "subagent.spawn",
  "subagent.profile.list",
  "subagent.profile.show",
  "subagent.profile.upsert",
  "subagent.profile.enable",
  "subagent.profile.disable",
  "a2a.send",
  "a2a.inspect",
  "a2a.history",
  "email.account.list",
  "email.list",
  "email.read",
  "email.search",
  "email.attachments.fetch",
  "email.send",
  "telegram.chat.list",
  "telegram.chat.info",
  "telegram.history",
  "telegram.media.fetch",
  "telegram.send",
  "telegram.react",
  "telegram.edit",
  "telegram.delete",
  "telegram.pin",
  "telegram.unpin",
  "telegram.sticker.send",
  "discord.channel.list",
  "discord.history",
  "discord.send",
  "whatsapp.chat.list",
  "whatsapp.history",
  "whatsapp.send",
  "env.list",
  "env.set",
  "env.clear",
  "vent.send",
  "web.fetch",
  "brave.web.search",
  "brave.news.search",
  "brave.video.search",
  "brave.image.search",
  "brave.llm.context",
  "brave.place.search",
  "brave.place.poi",
  "brave.place.description",
  "openai.web_research",
  "image.generate",
  "whisper.transcribe",
  "whisper.translate",
] as const;

function testCommand(name: "test.one" | "test.two"): RegisteredCommand {
  return {
    descriptor: {
      name,
      summary: name,
      description: name,
      usage: `panda ${name}`,
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    },
    async execute() {
      return {
        ok: true,
        command: name,
        output: {},
      };
    },
  };
}

function testModule(name: "test.one" | "test.two", enabled: boolean): CommandModule<{enabled: boolean}> {
  const command = testCommand(name);
  return {
    descriptor: command.descriptor,
    createCommand: (dependencies) => dependencies.enabled && enabled ? command : null,
  };
}

function phasedTestModule(
  name: "test.one" | "test.two",
  phase: NonNullable<CommandModule["registration"]>["phase"],
): CommandModule<{enabled: boolean}> {
  return {
    ...testModule(name, true),
    registration: {phase},
  };
}

function catalogTestModule(name: "test.one" | "test.two"): CommandCatalogModule<{enabled: boolean}> {
  return {
    ...phasedTestModule(name, "runtime"),
    route: {
      helpArgv: ["test", name],
      jsonArgv: ["test", name, "--json", "@payload.json"],
    },
    policy: {
      capability: name,
    },
  };
}

function defaultModuleDependencies(): AgentCommandModuleDependencies {
  return {
    env: {},
    backgroundJobService: {} as AgentCommandModuleDependencies["backgroundJobService"],
    watchStore: {} as AgentCommandModuleDependencies["watchStore"],
    watchMutations: {} as AgentCommandModuleDependencies["watchMutations"],
    scheduledTasks: {} as AgentCommandModuleDependencies["scheduledTasks"],
    apps: {} as AgentCommandModuleDependencies["apps"],
    appAuth: {} as AgentCommandModuleDependencies["appAuth"],
    resolveAppUrls: () => ({
      appUrl: "http://127.0.0.1/apps/example/",
      localAppUrl: "http://127.0.0.1/apps/example/",
    }),
    resolveAppLaunchUrls: () => ({
      appUrl: "http://127.0.0.1/apps/example/",
      localAppUrl: "http://127.0.0.1/apps/example/",
      openUrl: "http://127.0.0.1/apps/open?token=test",
    }),
    agentSkills: {} as AgentCommandModuleDependencies["agentSkills"],
    sessionPrompts: {} as AgentCommandModuleDependencies["sessionPrompts"],
    sessionTodos: {} as AgentCommandModuleDependencies["sessionTodos"],
    subagentProfiles: {} as AgentCommandModuleDependencies["subagentProfiles"],
    credentials: {} as AgentCommandModuleDependencies["credentials"],
    postgresReadonly: {
      pool: {} as NonNullable<AgentCommandModuleDependencies["postgresReadonly"]>["pool"],
    },
    executionEnvironments: {} as AgentCommandModuleDependencies["executionEnvironments"],
    environmentLifecycle: {} as AgentCommandModuleDependencies["environmentLifecycle"],
    wiki: {} as AgentCommandModuleDependencies["wiki"],
    subagentSessions: {} as AgentCommandModuleDependencies["subagentSessions"],
    connectorAccounts: {} as AgentCommandModuleDependencies["connectorAccounts"],
    conversations: {} as AgentCommandModuleDependencies["conversations"],
    channelMessages: {} as AgentCommandModuleDependencies["channelMessages"],
    outboundDeliveries: {} as AgentCommandModuleDependencies["outboundDeliveries"],
    channelActions: {} as AgentCommandModuleDependencies["channelActions"],
    email: {} as AgentCommandModuleDependencies["email"],
    a2aMessaging: {} as AgentCommandModuleDependencies["a2aMessaging"],
    a2aDeliveries: {} as AgentCommandModuleDependencies["a2aDeliveries"],
    commandFileResolver: {
      async resolveReadablePath({file}) {
        return {
          path: file.path,
          displayPath: file.path,
        };
      },
      async resolveWritablePath({file}) {
        return {
          path: file.path,
          displayPath: file.path,
        };
      },
    },
  };
}

describe("command modules", () => {
  it("builds Panda-local command policy metadata from typed tool groups", () => {
    expect(agentCommandPolicy(["memory"], {
      requiresIdentity: true,
      requiresReadonlyPostgres: true,
    })).toEqual({
      toolGroups: ["memory"],
      requiresIdentity: true,
      requiresReadonlyPostgres: true,
    });
  });

  it("defines modules through the public extension helpers", () => {
    const command = testCommand("test.one");
    const module = defineCommandModule({
      descriptor: command.descriptor,
      createCommand: (dependencies: {enabled: boolean}) => dependencies.enabled ? command : null,
    });
    const catalogModule = defineCommandCatalogModule({
      ...module,
      helpArgv: ["test", "one"],
      policy: {
        toolGroups: ["core"],
      },
      registrationPhase: "runtime.subagent" as const,
    });

    expect(createCommandsFromModules([catalogModule], {enabled: true}).map((command) => command.descriptor.name))
      .toEqual(["test.one"]);
    expect(commandRoutesFromModules([catalogModule])).toEqual([
      {
        command: "test.one",
        helpArgv: ["test", "one"],
        jsonArgv: ["test", "one", "--json", "@payload.json"],
      },
    ]);
    expect(catalogModule.policy).toEqual({
      capability: "test.one",
      toolGroups: ["core"],
    });
    expect(commandNamesForRegistrationPhase([catalogModule], "runtime.subagent")).toEqual(["test.one"]);
  });

  it("creates registered commands from enabled module factories", () => {
    const commands = createCommandsFromModules([
      testModule("test.one", true),
      testModule("test.two", false),
    ], {enabled: true});

    expect(commands.map((command) => command.descriptor.name)).toEqual(["test.one"]);
  });

  it("can instantiate only selected module commands", () => {
    const commands = createCommandsFromModules([
      testModule("test.one", true),
      testModule("test.two", true),
    ], {enabled: true}, {names: ["test.two"]});

    expect(commands.map((command) => command.descriptor.name)).toEqual(["test.two"]);
  });

  it("can exclude modules and require selected modules to create commands", () => {
    const commands = createCommandsFromModules([
      testModule("test.one", true),
      testModule("test.two", true),
    ], {enabled: true}, {excludeNames: ["test.two"]});

    expect(commands.map((command) => command.descriptor.name)).toEqual(["test.one"]);
    expect(() => createCommandsFromModules([
      testModule("test.one", false),
    ], {enabled: true}, {names: ["test.one"], requireAll: true})).toThrow(
      "Panda command module test.one did not create a command.",
    );
  });

  it("can instantiate modules by registration phase", () => {
    const commands = createCommandsFromModules([
      phasedTestModule("test.one", "runtime"),
      phasedTestModule("test.two", "daemon.channel"),
    ], {enabled: true}, {registrationPhase: "daemon.channel"});

    expect(commands.map((command) => command.descriptor.name)).toEqual(["test.two"]);
  });

  it("combines module catalogs while rejecting duplicate command names", () => {
    expect(combineCommandModules([
      testModule("test.one", true),
    ], [
      testModule("test.two", true),
    ]).map((module) => module.descriptor.name)).toEqual(["test.one", "test.two"]);

    expect(() => combineCommandModules([
      testModule("test.one", true),
    ], [
      testModule("test.one", true),
    ])).toThrow("Duplicate Panda command module test.one.");
  });

  it("creates a validated command catalog with projections and lookup", () => {
    const module = catalogTestModule("test.one");
    const catalog = createCommandCatalog([module]);

    expect(catalog.modules).toEqual([module]);
    expect(catalog.names()).toEqual(["test.one"]);
    expect(catalog.get("test.one")).toBe(module);
    expect(catalog.has("test.two")).toBe(false);
    expect(catalog.descriptors()).toEqual([module.descriptor]);
    expect(catalog.routes()).toEqual([
      {
        command: "test.one",
        helpArgv: ["test", "test.one"],
        jsonArgv: ["test", "test.one", "--json", "@payload.json"],
      },
    ]);
    expect(catalog.namesForToolGroups([])).toEqual([]);
    expect(catalog.createCommands({enabled: true}).map((command) => command.descriptor.name))
      .toEqual(["test.one"]);
    expect(() => createCommandCatalog([module], [module])).toThrow("Duplicate Panda command module test.one.");
  });

  it("keeps default command factories aligned with their module descriptors", () => {
    const commands = DEFAULT_AGENT_COMMAND_CATALOG.createCommands(
      defaultModuleDependencies(),
    );

    expect(commands.map((command) => command.descriptor.name)).toEqual(factoryBackedCommandNames);
    expect(commands.map((command) => command.descriptor)).toEqual(
      DEFAULT_AGENT_COMMAND_MODULES
        .filter((module) => module.createCommand)
        .map((module) => module.descriptor),
    );
  });

  it("builds an extended default agent command catalog", () => {
    const extraModule = catalogTestModule("test.one");
    const catalog = createDefaultAgentCommandCatalog({
      extraModules: [extraModule],
    });

    expect(catalog.get("test.one")).toBe(extraModule);
    expect(catalog.descriptors().at(-1)).toBe(extraModule.descriptor);
    expect(catalog.routes().at(-1)).toEqual({
      command: "test.one",
      helpArgv: ["test", "test.one"],
      jsonArgv: ["test", "test.one", "--json", "@payload.json"],
    });
    expect(() => createDefaultAgentCommandCatalog({
      extraModules: [DEFAULT_AGENT_COMMAND_MODULES[0]!],
    })).toThrow(`Duplicate Panda command module ${DEFAULT_AGENT_COMMAND_MODULES[0]!.descriptor.name}.`);
  });

  it("keeps the legacy module-array builder as a catalog projection", () => {
    const extraModule = catalogTestModule("test.one");
    const modules = buildDefaultAgentCommandModules({
      extraModules: [extraModule],
    });

    expect(modules.at(-1)?.descriptor.name).toBe("test.one");
    expect(commandDescriptorsFromModules(modules).at(-1)).toBe(extraModule.descriptor);
    expect(commandRoutesFromModules(modules).at(-1)).toEqual({
      command: "test.one",
      helpArgv: ["test", "test.one"],
      jsonArgv: ["test", "test.one", "--json", "@payload.json"],
    });
  });

  it("keeps default command module registration phases explicit", () => {
    expect(commandNamesForRegistrationPhase(DEFAULT_AGENT_COMMAND_MODULES, "runtime.subagent")).toEqual([
      "subagent.spawn",
    ]);
    expect(commandNamesForRegistrationPhase(DEFAULT_AGENT_COMMAND_MODULES, "daemon.a2a")).toEqual([
      "a2a.send",
      "a2a.inspect",
      "a2a.history",
    ]);
    expect(commandNamesForRegistrationPhase(DEFAULT_AGENT_COMMAND_MODULES, "daemon.channel")).toEqual([
      "email.account.list",
      "email.list",
      "email.read",
      "email.search",
      "email.attachments.fetch",
      "email.send",
      "telegram.chat.list",
      "telegram.chat.info",
      "telegram.history",
      "telegram.media.fetch",
      "telegram.send",
      "telegram.react",
      "telegram.edit",
      "telegram.delete",
      "telegram.pin",
      "telegram.unpin",
      "telegram.sticker.send",
      "discord.channel.list",
      "discord.history",
      "discord.send",
      "whatsapp.chat.list",
      "whatsapp.history",
      "whatsapp.send",
    ]);
  });
});
