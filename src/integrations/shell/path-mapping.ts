import path from "node:path";

import {resolveAgentDir} from "../../app/runtime/data-dir.js";
import {resolveBashExecutionMode, resolveRunnerCwd, resolveRunnerCwdTemplate,} from "./bash-executor.js";

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRemoteAgentRoots(
  agentKey: string,
  env: NodeJS.ProcessEnv,
): { hostAgentRoot: string; runnerAgentRoot: string } | null {
  if (resolveBashExecutionMode(env) !== "remote") {
    return null;
  }

  const runnerCwdTemplate = resolveRunnerCwdTemplate(env);
  if (!runnerCwdTemplate) {
    return null;
  }

  return {
    hostAgentRoot: path.resolve(resolveAgentDir(agentKey, env)),
    runnerAgentRoot: path.resolve(resolveRunnerCwd(runnerCwdTemplate, agentKey)),
  };
}

function mapPathBetweenRoots(
  resolvedPath: string,
  sourceRoot: string,
  targetRoot: string,
): string {
  if (!isPathWithinRoot(sourceRoot, resolvedPath)) {
    return resolvedPath;
  }

  const relativePath = path.relative(sourceRoot, resolvedPath);
  return path.join(targetRoot, relativePath);
}

export function mapHostAgentPathToRunner(
  targetPath: string,
  agentKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolvedPath = path.resolve(targetPath);
  const roots = resolveRemoteAgentRoots(agentKey, env);
  if (!roots) {
    return resolvedPath;
  }

  return mapPathBetweenRoots(resolvedPath, roots.hostAgentRoot, roots.runnerAgentRoot);
}

export function mapRunnerAgentPathToHost(
  targetPath: string,
  agentKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolvedPath = path.resolve(targetPath);
  const roots = resolveRemoteAgentRoots(agentKey, env);
  if (!roots) {
    return resolvedPath;
  }

  return mapPathBetweenRoots(resolvedPath, roots.runnerAgentRoot, roots.hostAgentRoot);
}
