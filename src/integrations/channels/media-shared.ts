import path from "node:path";

import type {JsonObject} from "../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../domain/channels/types.js";

/**
 * Renders one media descriptor as a stable multi-line block for prompt text.
 */
export function describeMediaDescriptor(
  descriptor: MediaDescriptor,
  extraLines: readonly string[] = [],
): string {
  const filename = descriptor.originalFilename ?? path.basename(descriptor.localPath);
  return [
    "- id: " + descriptor.id,
    `  filename: ${filename}`,
    `  mime_type: ${descriptor.mimeType}`,
    `  size_bytes: ${descriptor.sizeBytes}`,
    `  path: ${descriptor.localPath}`,
    ...extraLines.map((line) => `  ${line}`),
  ].join("\n");
}

/**
 * Serializes media descriptors into JSON metadata with consistent field names.
 */
export function serializeMediaDescriptor(descriptor: MediaDescriptor): JsonObject {
  return {
    id: descriptor.id,
    source: descriptor.source,
    connectorKey: descriptor.connectorKey,
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    localPath: descriptor.localPath,
    originalFilename: descriptor.originalFilename ?? null,
    metadata: descriptor.metadata ?? null,
    createdAt: descriptor.createdAt,
  };
}
