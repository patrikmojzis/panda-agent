import {
  ThreadRuntimeCoordinator as CoreThreadRuntimeCoordinator,
  type ThreadRuntimeCoordinatorOptions as CoreThreadRuntimeCoordinatorOptions,
} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadDefinitionResolver} from "../../domain/threads/runtime/types.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";

export * from "../../domain/threads/runtime/index.js";

export type ThreadRuntimeCoordinatorOptions =
  Omit<CoreThreadRuntimeCoordinatorOptions, "resolveDefinition"> & {
    resolveDefinition: ThreadDefinitionResolver;
  };

/** Package coordinator convenience; resolving defaults never persists a session override. */
export class ThreadRuntimeCoordinator extends CoreThreadRuntimeCoordinator {
  constructor(options: ThreadRuntimeCoordinatorOptions) {
    super({
      ...options,
      resolveDefinition: async (thread) => {
        const definition = await options.resolveDefinition(thread);
        return {...definition, model: definition.model ?? resolveDefaultAgentModelSelector()};
      },
    });
  }
}
