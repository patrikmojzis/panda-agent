import type {
  CommandFileResolver,
  CommandReadableFileReference,
  CommandWritableFileReference,
  ResolvedCommandReadableFile,
  ResolvedCommandWritableFile,
} from "../../domain/commands/files.js";
import type {CommandRequest, CommandScope} from "../../domain/commands/types.js";
import {resolveContextPath, resolveReadableContextPath} from "./panda-path-context.js";

function buildPathContext(scope: CommandScope, workingDirectory: string | undefined): {
  agentKey: string;
  cwd?: string;
  executionEnvironment?: CommandScope["executionEnvironment"];
} {
  return {
    agentKey: scope.agentKey,
    ...(workingDirectory ? {cwd: workingDirectory} : {}),
    ...(scope.executionEnvironment ? {executionEnvironment: scope.executionEnvironment} : {}),
  };
}

export class RuntimeCommandFileResolver implements CommandFileResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolveReadablePath(input: {
    request: CommandRequest;
    file: CommandReadableFileReference;
  }): Promise<ResolvedCommandReadableFile> {
    const displayPath = input.file.path;
    return {
      displayPath,
      path: await resolveReadableContextPath(
        displayPath,
        buildPathContext(input.request.scope, input.request.workingDirectory),
        this.env,
      ),
    };
  }

  async resolveWritablePath(input: {
    request: CommandRequest;
    file: CommandWritableFileReference;
  }): Promise<ResolvedCommandWritableFile> {
    const displayPath = input.file.path;
    return {
      displayPath,
      path: resolveContextPath(
        displayPath,
        buildPathContext(input.request.scope, input.request.workingDirectory),
        this.env,
      ),
    };
  }
}
