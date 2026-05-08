import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/index.js";

const CONSTRAINED_BASE_ENV_KEYS = ["PATH", "HOME", "SHELL", "TMPDIR", "TEMP", "TMP", "TERM", "LANG", "LC_ALL", "TZ"];

function buildConstrainedBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    CONSTRAINED_BASE_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
}

function shouldConstrainProcessEnv(environment: ResolvedExecutionEnvironment | undefined): boolean {
  return environment?.credentialPolicy.mode === "none" || environment?.credentialPolicy.mode === "allowlist";
}

export function buildShellProcessEnv(input: {
  processEnv: NodeJS.ProcessEnv;
  executionEnvironment?: ResolvedExecutionEnvironment;
  resolvedEnv?: Record<string, string>;
  shellEnv?: Record<string, string>;
  env?: Record<string, string>;
}): NodeJS.ProcessEnv {
  return {
    ...(shouldConstrainProcessEnv(input.executionEnvironment)
      ? buildConstrainedBaseEnv(input.processEnv)
      : input.processEnv),
    ...(input.resolvedEnv ?? {}),
    ...(input.shellEnv ?? {}),
    ...(input.env ?? {}),
  };
}
