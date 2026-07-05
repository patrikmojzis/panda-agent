import type {CommandRequest} from "./types.js";

export interface CommandReadableFileReference {
  path: string;
}

export interface CommandWritableFileReference {
  path: string;
}

export interface ResolvedCommandReadableFile {
  path: string;
  displayPath: string;
}

export interface ResolvedCommandWritableFile {
  path: string;
  displayPath: string;
}

export interface CommandFileResolver {
  resolveReadablePath(input: {
    request: CommandRequest;
    file: CommandReadableFileReference;
  }): Promise<ResolvedCommandReadableFile>;
}

export interface CommandWritableFileResolver {
  resolveWritablePath(input: {
    request: CommandRequest;
    file: CommandWritableFileReference;
  }): Promise<ResolvedCommandWritableFile>;
}
