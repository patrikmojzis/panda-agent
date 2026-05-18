import path from "node:path";
import {readFile, realpath, stat} from "node:fs/promises";

import type {AgentAppDefinition} from "../../domain/apps/types.js";
import {pathExists} from "../../lib/fs.js";
import {AgentAppRequestError} from "./http-errors.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function contentTypeForFile(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function ensureContainedPath(baseDir: string, relativePath: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the app public directory.");
  }

  return resolved;
}

function isContainedPath(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolves symlinks and rejects hardlinks so public app assets cannot expose
 * files outside the app's public directory.
 */
async function ensureRealContainedPath(
  rootDir: string,
  baseDir: string,
  targetPath: string,
): Promise<string> {
  const [realRootDir, realBaseDir, realTargetPath] = await Promise.all([
    realpath(rootDir),
    realpath(baseDir),
    realpath(targetPath),
  ]);
  if (!isContainedPath(realRootDir, realBaseDir) || !isContainedPath(realBaseDir, realTargetPath)) {
    throw new AgentAppRequestError(404, "Static asset not found.");
  }

  const targetStats = await stat(realTargetPath);
  if (!targetStats.isFile() || targetStats.nlink > 1) {
    throw new AgentAppRequestError(404, "Static asset not found.");
  }

  return realTargetPath;
}

export interface AgentAppStaticAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export async function readAgentAppStaticAsset(
  app: AgentAppDefinition,
  relativeAssetPath: string,
): Promise<AgentAppStaticAsset> {
  if (!app.hasUi) {
    throw new AgentAppRequestError(404, `App ${app.slug} does not expose a UI.`);
  }

  const targetPath = relativeAssetPath
    ? ensureContainedPath(app.publicDir, relativeAssetPath)
    : app.entryHtmlPath;
  if (!await pathExists(targetPath)) {
    throw new AgentAppRequestError(404, "Static asset not found.");
  }

  const safeTargetPath = await ensureRealContainedPath(app.appDir, app.publicDir, targetPath);
  return {
    bytes: await readFile(safeTargetPath),
    contentType: contentTypeForFile(safeTargetPath),
  };
}
