import type {
  CommandCatalogModule,
  CommandDescriptor,
  CommandModule,
  CommandName,
  CommandPolicyDescriptor,
  CommandPolicyModule,
  CommandRegistrationDescriptor,
  CommandRegistrationPhase,
  CommandRouteDescriptor,
  RegisteredCommand,
} from "./types.js";

export interface CreateCommandsFromModulesOptions {
  names?: readonly CommandName[];
  excludeNames?: readonly CommandName[];
  registrationPhase?: CommandRegistrationPhase | readonly CommandRegistrationPhase[];
  requireAll?: boolean;
}

export interface CommandCatalog<
  TDeps = any,
  TModule extends CommandCatalogModule<TDeps> = CommandCatalogModule<TDeps>,
> {
  readonly modules: readonly TModule[];
  get(name: CommandName): TModule | undefined;
  has(name: CommandName): boolean;
  names(): CommandName[];
  descriptors(): CommandDescriptor[];
  routes(): CommandRouteProjection[];
  namesForRegistrationPhase(phase: CommandRegistrationPhase): CommandName[];
  namesForToolGroups(groups: readonly string[]): CommandName[];
  createCommands(dependencies: TDeps, options?: CreateCommandsFromModulesOptions): RegisteredCommand[];
}

export interface CommandModuleIdentity {
  descriptor: {
    name: CommandName;
  };
}

export interface CommandDescriptorModule {
  descriptor: CommandDescriptor;
}

export interface CommandRouteModule extends CommandModuleIdentity {
  route: CommandRouteDescriptor;
}

export interface CommandRouteProjection extends CommandRouteDescriptor {
  command: CommandName;
}

type DefineCommandCatalogRouteInput =
  | {
    route: CommandRouteDescriptor;
    helpArgv?: never;
    jsonInput?: never;
  }
  | {
    helpArgv: readonly string[];
    jsonInput?: string;
    route?: never;
  };

export type DefineCommandCatalogModuleOptions<TDeps> = DefineCommandCatalogRouteInput & {
  descriptor: CommandDescriptor;
  policy?: Omit<CommandPolicyDescriptor, "capability"> & {capability?: CommandName};
  registration?: CommandRegistrationDescriptor;
  registrationPhase?: CommandRegistrationPhase;
  createCommand?: (dependencies: TDeps) => RegisteredCommand | null;
};

export const DEFAULT_COMMAND_REGISTRATION_PHASE: CommandRegistrationPhase = "runtime";

/** Define a Panda Command module while preserving its dependency and metadata type. */
export function defineCommandModule<TModule extends CommandModule<any>>(module: TModule): TModule {
  return module;
}

/**
 * Define a catalog-ready Panda Command module.
 *
 * Defaults `policy.capability` to the command name and can derive the JSON shim
 * route from `helpArgv`, keeping extension modules from duplicating catalog
 * metadata by hand.
 */
export function defineCommandCatalogModule<TDeps>(
  input: DefineCommandCatalogModuleOptions<TDeps>,
): CommandCatalogModule<TDeps> {
  const route: CommandRouteDescriptor = "route" in input && input.route
    ? input.route
    : {
      helpArgv: input.helpArgv,
      jsonArgv: [...input.helpArgv, "--json", input.jsonInput ?? "@payload.json"],
    };
  const {capability = input.descriptor.name, ...policy} = input.policy ?? {};
  const registration = input.registration
    ?? (input.registrationPhase ? {phase: input.registrationPhase} : undefined);

  return {
    descriptor: input.descriptor,
    route,
    policy: {
      capability,
      ...policy,
    },
    ...(registration ? {registration} : {}),
    ...(input.createCommand ? {createCommand: input.createCommand} : {}),
  };
}

/** Compose a validated Panda Command catalog with common projections behind one interface. */
export function createCommandCatalog<
  TDeps = any,
  TModule extends CommandCatalogModule<TDeps> = CommandCatalogModule<TDeps>,
>(
  ...moduleGroups: readonly (readonly TModule[])[]
): CommandCatalog<TDeps, TModule> {
  const modules = combineCommandModules(...moduleGroups);
  const modulesByName = new Map(modules.map((module) => [module.descriptor.name, module]));

  return {
    modules,
    get(name) {
      return modulesByName.get(name);
    },
    has(name) {
      return modulesByName.has(name);
    },
    names() {
      return modules.map((module) => module.descriptor.name);
    },
    descriptors() {
      return commandDescriptorsFromModules(modules);
    },
    routes() {
      return commandRoutesFromModules(modules);
    },
    namesForRegistrationPhase(phase) {
      return commandNamesForRegistrationPhase(modules, phase);
    },
    namesForToolGroups(groups) {
      return commandNamesForToolGroups(modules, groups);
    },
    createCommands(dependencies, options = {}) {
      return createCommandsFromModules(modules, dependencies, options);
    },
  };
}

export function commandRegistrationPhase(module: Pick<CommandModule, "registration">): CommandRegistrationPhase {
  return module.registration?.phase ?? DEFAULT_COMMAND_REGISTRATION_PHASE;
}

export function createCommandsFromModules<TDeps>(
  modules: readonly CommandModule<TDeps>[],
  dependencies: TDeps,
  options: CreateCommandsFromModulesOptions = {},
): RegisteredCommand[] {
  const names = options.names ? new Set(options.names) : null;
  const excluded = options.excludeNames ? new Set(options.excludeNames) : null;
  const phases = options.registrationPhase
    ? new Set(Array.isArray(options.registrationPhase) ? options.registrationPhase : [options.registrationPhase])
    : null;
  const commands: RegisteredCommand[] = [];
  for (const module of modules) {
    if (names && !names.has(module.descriptor.name)) {
      continue;
    }
    if (excluded?.has(module.descriptor.name)) {
      continue;
    }
    if (phases && !phases.has(commandRegistrationPhase(module))) {
      continue;
    }

    const command = module.createCommand?.(dependencies);
    if (command) {
      commands.push(command);
      continue;
    }
    if (options.requireAll) {
      throw new Error(`Panda command module ${module.descriptor.name} did not create a command.`);
    }
  }

  return commands;
}

export function commandNamesForRegistrationPhase(
  modules: readonly Pick<CommandModule, "descriptor" | "registration">[],
  phase: CommandRegistrationPhase,
): CommandName[] {
  return modules
    .filter((module) => commandRegistrationPhase(module) === phase)
    .map((module) => module.descriptor.name);
}

/** Compose command module catalogs while failing early on duplicate names. */
export function combineCommandModules<TModule extends CommandModuleIdentity>(
  ...moduleGroups: readonly (readonly TModule[])[]
): TModule[] {
  const modules: TModule[] = [];
  const seen = new Set<CommandName>();
  for (const group of moduleGroups) {
    for (const module of group) {
      if (seen.has(module.descriptor.name)) {
        throw new Error(`Duplicate Panda command module ${module.descriptor.name}.`);
      }
      seen.add(module.descriptor.name);
      modules.push(module);
    }
  }

  return modules;
}

/** Project the model-facing descriptor catalog from command modules. */
export function commandDescriptorsFromModules<TModule extends CommandDescriptorModule>(
  modules: readonly TModule[],
): CommandDescriptor[] {
  return modules.map((module) => module.descriptor);
}

/** Project command route metadata from command modules for CLI/shim adapters. */
export function commandRoutesFromModules<TModule extends CommandRouteModule>(
  modules: readonly TModule[],
): CommandRouteProjection[] {
  return modules.map((module) => ({
    command: module.descriptor.name,
    helpArgv: module.route.helpArgv,
    jsonArgv: module.route.jsonArgv,
  }));
}

/**
 * Return command grant keys contributed to any selected policy group, preserving module order.
 *
 * The grant key is `policy.capability` when present, defaulting to the executable
 * command name. Runtime leases convert this grant back to the concrete command.
 */
export function commandNamesForToolGroups(
  modules: readonly CommandPolicyModule[],
  groups: readonly string[],
): CommandName[] {
  const groupSet = new Set(groups);
  if (groupSet.size === 0) {
    return [];
  }

  const names: CommandName[] = [];
  const seen = new Set<CommandName>();
  for (const module of modules) {
    const toolGroups = module.policy?.toolGroups ?? [];
    if (!toolGroups.some((group) => groupSet.has(group))) {
      continue;
    }
    const capability = module.policy?.capability ?? module.descriptor.name;
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    names.push(capability);
  }

  return names;
}
