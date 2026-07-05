import type {CommandDescriptor, CommandName, CommandScope, RegisteredCommand} from "./types.js";

export interface CommandRegistry {
  get(name: CommandName): RegisteredCommand | undefined;
  list(scope?: CommandScope): readonly RegisteredCommand[];
  descriptors(scope?: CommandScope): readonly CommandDescriptor[];
}

function commandNameMatches(pattern: CommandName, command: CommandName): boolean {
  if (pattern === command) {
    return true;
  }

  return pattern.endsWith(".*") && command.startsWith(pattern.slice(0, -1));
}

/**
 * Checks session command allowlists using exact names or namespace wildcards.
 */
export function isCommandAllowed(scope: CommandScope | undefined, command: CommandName): boolean {
  if (!scope) {
    return true;
  }
  if (!scope.allowedCommands || scope.allowedCommands.length === 0) {
    return false;
  }

  return scope.allowedCommands.some((allowed) => commandNameMatches(allowed, command));
}

export function createStaticCommandRegistry(commands: readonly RegisteredCommand[]): CommandRegistry {
  const byName = new Map<CommandName, RegisteredCommand>();
  for (const command of commands) {
    if (byName.has(command.descriptor.name)) {
      throw new Error(`Duplicate Panda command ${command.descriptor.name}.`);
    }
    byName.set(command.descriptor.name, command);
  }

  return {
    get(name) {
      return byName.get(name);
    },
    list(scope) {
      return [...byName.values()].filter((command) => isCommandAllowed(scope, command.descriptor.name));
    },
    descriptors(scope) {
      return this.list(scope).map((command) => command.descriptor);
    },
  };
}
