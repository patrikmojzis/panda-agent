import path from "node:path";
import {trimToNull} from "../../lib/strings.js";

export const DEFAULT_SMOKE_TIMEOUT_MS = 120_000;
export const DEFAULT_SMOKE_ARTIFACT_ROOT = ".temp/runtime-smoke";

function normalizeArtifactSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "smoke";
}

export function resolveSmokeDatabaseUrl(
  explicitDbUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return trimToNull(explicitDbUrl) ?? trimToNull(env.TEST_DATABASE_URL);
}

export function requireSmokeDatabaseUrl(
  explicitDbUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dbUrl = resolveSmokeDatabaseUrl(explicitDbUrl, env);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Live smoke requires Postgres. Pass --db-url or set TEST_DATABASE_URL.");
}

export function resolveSmokeModelSelector(
  explicitModel?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return trimToNull(explicitModel) ?? trimToNull(env.TEST_MODEL) ?? undefined;
}

export function resolveSmokeArtifactDirectory(input: {
  agentKey: string;
  artifactsDir?: string;
  cwd?: string;
  now?: Date;
}): string {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const explicitArtifactsDir = trimToNull(input.artifactsDir);
  if (explicitArtifactsDir) {
    return path.resolve(cwd, explicitArtifactsDir);
  }

  const timestamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return path.resolve(cwd, DEFAULT_SMOKE_ARTIFACT_ROOT, `${timestamp}-${normalizeArtifactSlug(input.agentKey)}`);
}
