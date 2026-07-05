import {describe, expect, it, vi} from "vitest";

import {createCommandCatalog, type CommandCatalogModule} from "../src/domain/commands/modules.js";
import type {CommandDescriptor, CommandName, CommandScope} from "../src/domain/commands/types.js";
import {resolveVisibleCommandDescriptors} from "../src/app/runtime/command-visibility.js";

function descriptor(name: CommandName): CommandDescriptor {
  return {
    name,
    summary: name,
    description: name,
    usage: `panda ${name}`,
    inputModes: ["json"],
    outputModes: ["json"],
    arguments: [],
    examples: [],
  };
}

function catalogModule(name: CommandName): CommandCatalogModule {
  return {
    descriptor: descriptor(name),
    route: {
      helpArgv: name.split("."),
      jsonArgv: [...name.split("."), "--json", "@payload.json"],
    },
    policy: {
      capability: name,
    },
  };
}

function listRegisteredDescriptors(
  registeredDescriptors: readonly CommandDescriptor[],
): (scope?: CommandScope) => readonly CommandDescriptor[] {
  return (scope) => registeredDescriptors.filter((registered) => (
    scope?.allowedCommands?.includes(registered.name) ?? true
  ));
}

describe("command descriptor visibility", () => {
  it("renders registered descriptors allowed by command authority", async () => {
    const registeredDescriptor = descriptor("custom.registered");
    const unregisteredDescriptor = descriptor("custom.unregistered");
    const listCommands = vi.fn(listRegisteredDescriptors([registeredDescriptor]));

    await expect(resolveVisibleCommandDescriptors({
      commandCatalog: createCommandCatalog([
        catalogModule(registeredDescriptor.name),
        catalogModule(unregisteredDescriptor.name),
      ]),
      commandExecutor: {listCommands},
      session: {agentKey: "panda", id: "session-main"},
      executionEnvironment: {
        id: "env-main",
        source: "binding",
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: [registeredDescriptor.name, unregisteredDescriptor.name],
        },
      },
    })).resolves.toEqual([registeredDescriptor]);
    expect(listCommands).toHaveBeenCalledWith(expect.objectContaining({
      allowedCommands: [registeredDescriptor.name, unregisteredDescriptor.name],
      environmentId: "env-main",
    }));
  });

  it("does not ask the dispatcher with an empty allowlist", async () => {
    const listCommands = vi.fn(listRegisteredDescriptors([descriptor("custom.registered")]));

    await expect(resolveVisibleCommandDescriptors({
      commandCatalog: createCommandCatalog([
        catalogModule("custom.registered"),
      ]),
      commandExecutor: {listCommands},
      session: {agentKey: "panda", id: "session-main"},
      executionEnvironment: {
        id: "env-main",
        source: "binding",
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          allowedTools: ["bash"],
        },
      },
    })).resolves.toEqual([]);
    expect(listCommands).not.toHaveBeenCalled();
  });
});
