import path from "node:path";

import {resolveAgentDir} from "../../app/runtime/data-dir.js";
import {mapPathBetweenRoots} from "../../domain/execution-environments/index.js";
import {resolveBashExecutionMode, resolveRunnerCwd, resolveRunnerCwdTemplate,} from "./bash-executor.js";

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

function mapPathBetweenRemoteRoots(
  resolvedPath: string,
  sourceRoot: string,
  targetRoot: string,
): string {
  return mapPathBetweenRoots(resolvedPath, sourceRoot, targetRoot) ?? resolvedPath;
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

  return mapPathBetweenRemoteRoots(resolvedPath, roots.hostAgentRoot, roots.runnerAgentRoot);
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

  return mapPathBetweenRemoteRoots(resolvedPath, roots.runnerAgentRoot, roots.hostAgentRoot);
}
