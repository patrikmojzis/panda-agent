import {randomUUID} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {normalizePathLabel} from "../../lib/path-segments.js";
import type {TelepathyScreenshotCapture} from "./hub.js";
import {decodeTelepathyMediaPayload} from "./protocol.js";

export interface PersistTelepathyScreenshotArtifactOptions {
  rootDir: string;
  scopeKey: string;
  now?: () => number;
  randomId?: () => string;
}

export interface PersistedTelepathyScreenshotArtifact {
  byteLength: number;
  path: string;
}

function screenshotExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      throw new ToolError(`Unsupported telepathy screenshot MIME type: ${mimeType}`);
  }
}

function assertPathWithinRoot(rootDir: string, candidatePath: string): void {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new ToolError(`Telepathy screenshot path escaped media root: ${candidatePath}`);
}

/**
 * Persists a Telepathy screenshot artifact under the agent media root.
 */
export async function persistTelepathyScreenshotArtifact(
  capture: TelepathyScreenshotCapture,
  options: PersistTelepathyScreenshotArtifactOptions,
): Promise<PersistedTelepathyScreenshotArtifact> {
  const rootDir = path.resolve(options.rootDir);
  const artifactDir = path.join(
    rootDir,
    "telepathy",
    normalizePathLabel(options.scopeKey),
    normalizePathLabel(capture.deviceId),
  );
  assertPathWithinRoot(rootDir, artifactDir);
  await mkdir(artifactDir, {recursive: true});

  const bytes = decodeTelepathyMediaPayload({
    data: capture.data,
    ...(capture.bytes !== undefined ? {bytes: capture.bytes} : {}),
    kind: "screenshot",
  });
  const persistedPath = path.join(
    artifactDir,
    `${options.now?.() ?? Date.now()}-${options.randomId?.() ?? randomUUID()}${screenshotExtension(capture.mimeType)}`,
  );
  assertPathWithinRoot(rootDir, persistedPath);
  await writeFile(persistedPath, bytes);

  return {
    byteLength: bytes.length,
    path: persistedPath,
  };
}
