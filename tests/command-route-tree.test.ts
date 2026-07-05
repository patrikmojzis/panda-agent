import {describe, expect, it} from "vitest";

import {buildCommandRouteTree} from "../src/domain/commands/route-tree.js";
import type {CommandDescriptor, CommandName} from "../src/domain/commands/types.js";
import type {CommandRouteProjection} from "../src/domain/commands/modules.js";

function descriptor(name: CommandName): CommandDescriptor {
  return {
    name,
    summary: `${name} summary`,
    description: `${name} description`,
    usage: `panda ${name.replace(".", " ")}`,
    inputModes: ["json"],
    outputModes: ["json"],
    arguments: [],
    examples: [],
  };
}

function route(command: CommandName, helpArgv: readonly string[], jsonInput = "@payload.json"): CommandRouteProjection {
  return {
    command,
    helpArgv,
    jsonArgv: [...helpArgv, "--json", jsonInput],
  };
}

describe("command route tree", () => {
  it("projects flat command routes into grouped command leaves", () => {
    const watchList = descriptor("watch.list");
    const watchCreate = descriptor("watch.create");
    const skillLoad = descriptor("skill.load");

    const tree = buildCommandRouteTree({
      descriptors: [watchList, watchCreate, skillLoad],
      routes: [
        route("watch.list", ["watch", "list"], "{}"),
        route("watch.create", ["watch", "create"]),
        route("skill.load", ["skill", "load"]),
      ],
    });

    expect(tree.commands.map((command) => command.command)).toEqual([
      "watch.list",
      "watch.create",
      "skill.load",
    ]);
    expect(tree.commands[0]).toMatchObject({
      command: "watch.list",
      argv: ["watch", "list"],
      jsonInput: "{}",
      descriptor: watchList,
    });
    expect(tree.groups.map((group) => group.name)).toEqual(["watch", "skill"]);
    expect(tree.groups[0]?.commands.map((command) => command.command)).toEqual([
      "watch.list",
      "watch.create",
    ]);
  });

  it("builds nested route groups", () => {
    const tree = buildCommandRouteTree({
      descriptors: [descriptor("session.prompt.read")],
      routes: [
        route("session.prompt.read", ["session", "prompt", "current"]),
      ],
    });

    expect(tree.groups[0]).toMatchObject({
      name: "session",
      argv: ["session"],
      groups: [
        {
          name: "prompt",
          argv: ["session", "prompt"],
          commands: [
            {
              command: "session.prompt.read",
              argv: ["session", "prompt", "current"],
            },
          ],
        },
      ],
    });
  });

  it("rejects duplicate route paths and missing descriptors", () => {
    expect(() => buildCommandRouteTree({
      descriptors: [descriptor("watch.list"), descriptor("watch.show")],
      routes: [
        route("watch.list", ["watch", "list"]),
        route("watch.show", ["watch", "list"]),
      ],
    })).toThrow("Duplicate Panda command route watch list.");

    expect(() => buildCommandRouteTree({
      descriptors: [],
      routes: [
        route("watch.list", ["watch", "list"]),
      ],
    })).toThrow("Missing Panda command descriptor for route watch.list.");
  });
});
