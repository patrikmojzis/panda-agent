import {
  ThreadRuntimeCoordinator as CoreThreadRuntimeCoordinator,
  type ThreadRuntimeCoordinatorOptions as CoreThreadRuntimeCoordinatorOptions,
} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadDefinitionResolver} from "../../domain/threads/runtime/types.js";
import {overrideConfigurationProperty, withDefaultModel} from "./model-defaults.js";

export * from "../../domain/threads/runtime/index.js";

export type ThreadRuntimeCoordinatorOptions =
  Omit<CoreThreadRuntimeCoordinatorOptions, "resolveDefinition"> & {
    resolveDefinition: ThreadDefinitionResolver;
  };

export type ThreadRuntimeCoordinator = CoreThreadRuntimeCoordinator;

/** Shares core instance identity while keeping optional-model resolution at the package boundary. */
export const ThreadRuntimeCoordinator = new Proxy(CoreThreadRuntimeCoordinator, {
  construct(target, [options]: [ThreadRuntimeCoordinatorOptions], newTarget) {
    const resolveDefinition: CoreThreadRuntimeCoordinatorOptions["resolveDefinition"] = async (thread) => (
      withDefaultModel(await options.resolveDefinition(thread))
    );
    return Reflect.construct(target, [overrideConfigurationProperty(options, "resolveDefinition", resolveDefinition)], newTarget);
  },
}) as typeof CoreThreadRuntimeCoordinator & {
  new(options: ThreadRuntimeCoordinatorOptions): ThreadRuntimeCoordinator;
};
