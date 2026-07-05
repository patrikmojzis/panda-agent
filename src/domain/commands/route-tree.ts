import type {CommandDescriptor, CommandName} from "./types.js";
import type {CommandRouteProjection} from "./modules.js";

export interface CommandRouteTreeLeaf {
  kind: "command";
  command: CommandName;
  argv: readonly string[];
  jsonArgv: readonly string[];
  jsonInput?: string;
  descriptor: CommandDescriptor;
}

export interface CommandRouteTreeGroup {
  kind: "group";
  name: string;
  argv: readonly string[];
  groups: CommandRouteTreeGroup[];
  commands: CommandRouteTreeLeaf[];
}

export interface CommandRouteTree {
  groups: CommandRouteTreeGroup[];
  commands: CommandRouteTreeLeaf[];
}

function readJsonInput(route: CommandRouteProjection): string | undefined {
  const jsonFlagIndex = route.jsonArgv.indexOf("--json");
  if (jsonFlagIndex < 0) {
    return undefined;
  }

  return route.jsonArgv[jsonFlagIndex + 1];
}

function findOrCreateGroup(
  groups: CommandRouteTreeGroup[],
  name: string,
  argv: readonly string[],
): CommandRouteTreeGroup {
  const existing = groups.find((group) => group.name === name);
  if (existing) {
    return existing;
  }

  const group: CommandRouteTreeGroup = {
    kind: "group",
    name,
    argv,
    groups: [],
    commands: [],
  };
  groups.push(group);
  return group;
}

/** Project flat command routes into a reusable prefix tree for CLI/help adapters. */
export function buildCommandRouteTree(input: {
  routes: readonly CommandRouteProjection[];
  descriptors: readonly CommandDescriptor[];
}): CommandRouteTree {
  const descriptorsByName = new Map(input.descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const routeKeys = new Set<string>();
  const rootGroups: CommandRouteTreeGroup[] = [];
  const commands: CommandRouteTreeLeaf[] = [];

  for (const route of input.routes) {
    const routeKey = route.helpArgv.join("\0");
    if (routeKeys.has(routeKey)) {
      throw new Error(`Duplicate Panda command route ${route.helpArgv.join(" ")}.`);
    }
    routeKeys.add(routeKey);

    const descriptor = descriptorsByName.get(route.command);
    if (!descriptor) {
      throw new Error(`Missing Panda command descriptor for route ${route.command}.`);
    }

    const leaf: CommandRouteTreeLeaf = {
      kind: "command",
      command: route.command,
      argv: route.helpArgv,
      jsonArgv: route.jsonArgv,
      ...(readJsonInput(route) !== undefined ? {jsonInput: readJsonInput(route)} : {}),
      descriptor,
    };
    commands.push(leaf);

    let groups = rootGroups;
    for (const [index, segment] of route.helpArgv.slice(0, -1).entries()) {
      const group = findOrCreateGroup(groups, segment, route.helpArgv.slice(0, index + 1));
      groups = group.groups;
      if (index === route.helpArgv.length - 2) {
        group.commands.push(leaf);
      }
    }
  }

  return {
    groups: rootGroups,
    commands,
  };
}
