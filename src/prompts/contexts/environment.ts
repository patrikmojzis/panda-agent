import type {ExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";

export interface EnvironmentStorageContextInput {
  target: string;
  cwd?: string;
  persistentRoots?: readonly string[];
  filesystem?: ExecutionEnvironmentFilesystemMetadata | null;
  disposable?: boolean;
}

/** Renders declared storage coordinates and retention for one execution target. */
export function renderEnvironmentStorageContext(input: EnvironmentStorageContextInput): string {
  const lines = [
    `Storage for bash target ${JSON.stringify(input.target)}:`,
    ...(input.cwd ? [`Initial working directory: ${input.cwd}`] : []),
    input.persistentRoots?.length
      ? `Declared persistent roots: ${input.persistentRoots.join(", ")}`
      : "Persistent roots: unspecified; do not infer durability from HOME or cwd.",
  ];
  if (input.filesystem) {
    if (input.filesystem.root.parentRunnerPath) {
      lines.push(`Owner-runner root: ${input.filesystem.root.parentRunnerPath}`);
    }
    for (const key of ["workspace", "inbox", "artifacts"] as const) {
      const paths = input.filesystem[key];
      lines.push(`Configured ${key}: ${paths.workerPath}`);
      if (paths.parentRunnerPath) {
        lines.push(`Owner-runner ${key}: ${paths.parentRunnerPath}`);
      }
    }
    lines.push("These are configured coordinates, not an availability check. Owner-runner paths apply only on that runner, not every recipient or target.");
    lines.push("Write handoff outputs to the configured artifacts directory.");
    if (input.disposable) {
      lines.push("Environment stop retains these mapped directories; purge deletes them. The owner must copy accepted outputs needed long-term into its declared persistent storage before purge.");
    }
  }
  return lines.join("\n");
}

export function renderEnvironmentContext(options: {
  username: string;
  hostname: string;
  osLabel: string;
  hardware: string;
  runtime: string;
  storage: EnvironmentStorageContextInput;
}): string {
  return `
User: ${options.username} @ ${options.hostname}
OS: ${options.osLabel}
Hardware: ${options.hardware}
Runtime: ${options.runtime}
${renderEnvironmentStorageContext(options.storage)}
Keep reusable source, non-secret configuration, state, and dependency manifests in declared persistent roots. Keep dependency installation reproducible; use temporary directories for reproducible scratch work. Other paths may disappear when a runner is recreated. Storage declarations apply only to the named target, and persistence does not imply file-sharing access.
`.trim();
}
