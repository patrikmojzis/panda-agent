import {ToolError} from "../../kernel/agent/exceptions.js";

const DEPRECATED_BASH_SERVER_ENV_MAPPINGS = {
  RUNNER_URL_TEMPLATE: "BASH_SERVER_URL_TEMPLATE",
  RUNNER_CWD_TEMPLATE: "BASH_SERVER_CWD_TEMPLATE",
  RUNNER_AGENT_KEY: "BASH_SERVER_AGENT_KEY",
  RUNNER_HOST: "BASH_SERVER_HOST",
  RUNNER_PORT: "BASH_SERVER_PORT",
  RUNNER_SHARED_SECRET: "BASH_SERVER_SHARED_SECRET",
  RUNNER_ALLOWED_ROOTS: "BASH_SERVER_ALLOWED_ROOTS",
} as const;

export type DeprecatedBashServerEnvName = keyof typeof DEPRECATED_BASH_SERVER_ENV_MAPPINGS;

export const CORE_BASH_SERVER_ENV_NAMES = [
  "RUNNER_URL_TEMPLATE",
  "RUNNER_CWD_TEMPLATE",
  "RUNNER_SHARED_SECRET",
] satisfies readonly DeprecatedBashServerEnvName[];

export const BASH_SERVER_PROCESS_ENV_NAMES = [
  "RUNNER_AGENT_KEY",
  "RUNNER_HOST",
  "RUNNER_PORT",
  "RUNNER_SHARED_SECRET",
  "RUNNER_ALLOWED_ROOTS",
] satisfies readonly DeprecatedBashServerEnvName[];

export const DOCKER_MANAGER_BASH_SERVER_ENV_NAMES = [
  "RUNNER_SHARED_SECRET",
] satisfies readonly DeprecatedBashServerEnvName[];

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] !== undefined;
}

export function assertNoDeprecatedBashServerEnv(
  env: NodeJS.ProcessEnv,
  names: readonly DeprecatedBashServerEnvName[],
): void {
  const present = names.filter((name) => hasEnvValue(env, name));
  if (present.length === 0) {
    return;
  }

  const mappings = present
    .map((name) => `${name} was renamed to ${DEPRECATED_BASH_SERVER_ENV_MAPPINGS[name]}`)
    .join("; ");
  throw new ToolError(
    `Deprecated bash-server env ${present.length === 1 ? "variable" : "variables"}: ${mappings}. Remove the old ${present.length === 1 ? "variable" : "variables"}; BASH_SERVER_* is a hard cut with no RUNNER_* aliases.`,
  );
}
