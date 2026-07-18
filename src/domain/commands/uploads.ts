export interface CommandUploadDescriptor {
  uploadRef: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ResolvedCommandUpload extends CommandUploadDescriptor {
  path: string;
}

export interface CommandUploadScope {
  agentKey: string;
  sessionId: string;
}

/** Resolves and owns opaque files uploaded through the authenticated command transport. */
export interface CommandUploadStore {
  inspect(scope: CommandUploadScope, uploadRef: string): Promise<CommandUploadDescriptor>;
  resolve(scope: CommandUploadScope, uploadRef: string): Promise<ResolvedCommandUpload>;
  remove(scope: CommandUploadScope, uploadRef: string): Promise<void>;
}
