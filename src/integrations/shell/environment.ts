import path from "node:path";

import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";

export const SAFE_SYSTEM_PATH_ENTRIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;
export const SAFE_SYSTEM_PATH = SAFE_SYSTEM_PATH_ENTRIES.join(":");
export const SAFE_SHELL = "/bin/bash";
export const SAFE_HOME = "/root";
export const SAFE_TMPDIR = "/tmp";
export const SAFE_LANG = "C.UTF-8";

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

function splitPathEntries(value: string | undefined): string[] {
  return (value ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeRuntimePathEntries(): string[] {
  const nodeBinDirectory = path.dirname(process.execPath);
  return path.isAbsolute(nodeBinDirectory) ? [nodeBinDirectory] : [];
}

export function appendMissingSafePathEntries(value: string | undefined): string {
  const entries = splitPathEntries(value);
  const seen = new Set(entries);
  for (const safeEntry of [...SAFE_SYSTEM_PATH_ENTRIES, ...safeRuntimePathEntries()]) {
    if (!seen.has(safeEntry)) {
      entries.push(safeEntry);
      seen.add(safeEntry);
    }
  }

  return entries.join(":") || SAFE_SYSTEM_PATH;
}

export function buildSafeCommandBaseEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: SAFE_SYSTEM_PATH,
    SHELL: SAFE_SHELL,
    HOME: SAFE_HOME,
    TMPDIR: SAFE_TMPDIR,
    LANG: SAFE_LANG,
    ...(typeof env.TZ === "string" && env.TZ.length > 0 ? {TZ: env.TZ} : {}),
  };
}

export function buildSafeCommandEnv(input: {
  env?: Record<string, string> | NodeJS.ProcessEnv;
  processEnv?: NodeJS.ProcessEnv;
  home?: string;
} = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...buildSafeCommandBaseEnv(input.processEnv),
    ...(input.home ? {HOME: input.home} : {}),
    ...(input.env ?? {}),
  };

  return {
    ...merged,
    PATH: appendMissingSafePathEntries(merged.PATH),
  };
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
