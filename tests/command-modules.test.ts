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
import {resolveCommandLeaseAuthority} from "../src/domain/execution-environments/command-authority.js";
import {
  buildDefaultAgentCommandModules,
  createDefaultAgentCommandCatalog,
  DEFAULT_AGENT_COMMAND_CATALOG,
  DEFAULT_AGENT_COMMAND_MODULES,
} from "../src/panda/commands/agent-command-modules.js";
import {agentCommandPolicy} from "../src/panda/commands/agent-command-policy.js";

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

  it("discovers the default catalog without constructing runtime services", () => {
    expect(DEFAULT_AGENT_COMMAND_CATALOG.get("todo.list")?.descriptor.usage).toContain("todo list");
    expect(DEFAULT_AGENT_COMMAND_CATALOG.get("watch.create")?.route.helpArgv).toEqual(["watch", "create"]);
  });

  it.each([
    ["watch.list", "watchStore"],
    ["watch.create", "watchMutations"],
    ["schedule.list", "scheduledTasks"],
    ["session.prompt.read", "sessionPrompts"],
    ["todo.list", "sessionTodos"],
    ["subagent.profile.list", "subagentProfiles"],
    ["subagent.list", "subagentInventory"],
    ["skill.list", "agentSkills"],
  ] as const)("retains the public missing-service error for %s", (name, service) => {
    expect(() => DEFAULT_AGENT_COMMAND_CATALOG.createCommands({}, {names: [name]}))
      .toThrow(`Agent command module requires ${service}.`);
  });

  it("binds a selected read family without unrelated mutation or runtime services", async () => {
    const [command] = DEFAULT_AGENT_COMMAND_CATALOG.createCommands({
      watchStore: {
        async listWatches(input) {
          expect(input.sessionId).toBe("session-current");
          return [];
        },
        async getWatch() { throw new Error("Unexpected watch detail read."); },
        async listWatchRuns() { throw new Error("Unexpected watch run read."); },
        async disableWatch() { throw new Error("Unexpected watch mutation."); },
      },
    }, {names: ["watch.list"], requireAll: true});

    await expect(command!.execute({
      command: "watch.list",
      input: {},
      scope: {agentKey: "panda", sessionId: "session-current"},
    })).resolves.toMatchObject({ok: true, output: {operation: "list", count: 0, watches: []}});
  });

  it("keeps unconfigured optional integrations absent until explicitly required", () => {
    const names = ["heartbeat.show", "cron.list", "wiki.read", "session.compact", "subagent.spawn"] as const;
    expect(DEFAULT_AGENT_COMMAND_CATALOG.createCommands({}, {names})).toEqual([]);
    expect(() => DEFAULT_AGENT_COMMAND_CATALOG.createCommands({}, {names: ["cron.list"], requireAll: true}))
      .toThrow("Panda command module cron.list did not create a command.");
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
      "telegram.sticker.inspect",
      "telegram.sticker.save",
      "telegram.sticker.list",
      "telegram.sticker.set.show",
      "telegram.sticker.set.save",
      "telegram.sticker.send",
      "discord.channel.list",
      "discord.voice.join",
      "discord.voice.leave",
      "discord.voice.send",
      "discord.voice.status",
      "discord.history",
      "discord.sticker.list",
      "discord.sticker.send",
      "discord.gif.send",
      "discord.send",
      "whatsapp.chat.list",
      "whatsapp.history",
      "whatsapp.send",
      "whatsapp.call.status",
      "whatsapp.call.send",
      "whatsapp.call.hangup",
    ]);
  });

  it("grants inventory through subagent.spawn without adding it to profile tool groups", () => {
    const grantedSubagentCommands = resolveCommandLeaseAuthority({
      commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG,
      toolPolicy: {allowedTools: ["subagent.spawn"]},
    }).filter((name) => name.startsWith("subagent."));

    expect(grantedSubagentCommands).toEqual([
      "subagent.spawn",
      "subagent.list",
      "subagent.show",
    ]);
    expect(DEFAULT_AGENT_COMMAND_CATALOG.namesForToolGroups([
      "core",
      "operate",
      "memory",
      "internet",
      "skill_maintenance",
    ])).not.toEqual(expect.arrayContaining(["subagent.list", "subagent.show"]));
  });
});
