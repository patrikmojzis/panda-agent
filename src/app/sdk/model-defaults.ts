import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";

/** Overrides one app-boundary input without copying fields or changing getter receivers. */
export function overrideConfigurationProperty<T extends object, K extends PropertyKey, V>(
  configuration: T, key: K, value: V,
): T & Record<K, V> {
  // A separate target also permits overriding frozen, non-configurable input fields.
  return new Proxy({[key]: value}, {
    get: (_target, property) => property === key ? value : Reflect.get(configuration, property, configuration),
  }) as T & Record<K, V>;
}

/** Resolves only the optional model; all other configuration remains owned by the caller. */
export function withDefaultModel<T extends {model?: string}>(configuration: T): T & {model: string} {
  return overrideConfigurationProperty(configuration, "model", configuration.model ?? resolveDefaultAgentModelSelector());
}
