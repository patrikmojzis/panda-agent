import {randomUUID} from "node:crypto";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {resolveAgentMediaDir, resolveMediaDir} from "../../../app/runtime/data-dir.js";
import {resolveContextPath} from "../../../app/runtime/panda-path-context.js";
import type {DefaultAgentSessionContext} from "../../../app/runtime/panda-session-context.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {ToolArtifactDescriptor} from "../../../kernel/agent/tool-artifacts.js";
import type {JsonObject} from "../../../kernel/agent/types.js";
import {
  type GeneratedOpenAIImage,
  type OpenAIImageInputImage,
  type OpenAIImageOutputFormat,
  resolveOpenAIImageMime,
} from "../../../integrations/providers/openai-image/client.js";
import {trimToNull, trimToUndefined} from "../../../lib/strings.js";

export interface PersistedGeneratedImage {
  path: string;
  mimeType: string;
  bytes: number;
  fileName: string;
  revisedPrompt?: string;
}

const MAX_REFERENCE_IMAGE_BYTES = 15 * 1024 * 1024;
const REFERENCE_IMAGE_MIME_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function normalizeFileLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "unknown";
}

function safeAgentKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new ToolError(`Unsafe agent key for image artifact path: ${agentKey}`);
  }

  return trimmed;
}

function resolveScopeKey(context: Partial<DefaultAgentSessionContext>): string {
  const threadId = trimToUndefined(context.threadId);
  return threadId ? normalizeFileLabel(threadId) : `ephemeral-${randomUUID()}`;
}

function resolveImageGenerationMediaRoot(
  context: Partial<DefaultAgentSessionContext> | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const agentKey = trimToNull(context?.agentKey);
  if (agentKey) {
    return resolveAgentMediaDir(safeAgentKey(agentKey), env);
  }

  return resolveMediaDir(env);
}

function inferReferenceMimeType(filePath: string): string {
  const mimeType = REFERENCE_IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase());
  if (!mimeType) {
    throw new ToolError(
      `Unsupported reference image type for ${filePath}. Supported types: png, jpg, jpeg, webp.`,
    );
  }
  return mimeType;
}

async function ensureReadableReferenceImage(filePath: string): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new ToolError(`No readable reference image found at ${filePath}`);
  }

  if (!fileStat.isFile()) {
    throw new ToolError(`Expected a reference image file at ${filePath}`);
  }

  if (fileStat.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ToolError(
      `Reference image at ${filePath} is ${fileStat.size} bytes. image_generate accepts local reference images up to 15 MB.`,
    );
  }
}

export async function loadReferenceImages(params: {
  paths: readonly string[];
  context: unknown;
  env: NodeJS.ProcessEnv;
}): Promise<readonly OpenAIImageInputImage[]> {
  const images: OpenAIImageInputImage[] = [];
  for (const inputPath of params.paths) {
    const resolvedPath = resolveContextPath(inputPath, params.context, params.env);
    const mimeType = inferReferenceMimeType(resolvedPath);
    await ensureReadableReferenceImage(resolvedPath);
    images.push({
      fileName: path.basename(resolvedPath),
      mimeType,
      buffer: await readFile(resolvedPath),
    });
  }

  return images;
}

export async function persistGeneratedImages(params: {
  images: readonly GeneratedOpenAIImage[];
  context: Partial<DefaultAgentSessionContext>;
  env: NodeJS.ProcessEnv;
  outputFormat: OpenAIImageOutputFormat;
}): Promise<readonly PersistedGeneratedImage[]> {
  const root = resolveImageGenerationMediaRoot(params.context, params.env);
  const artifactDir = path.join(root, "image-generation", resolveScopeKey(params.context));
  await mkdir(artifactDir, {recursive: true});

  const output = resolveOpenAIImageMime(params.outputFormat);
  const persisted: PersistedGeneratedImage[] = [];
  for (const [index, image] of params.images.entries()) {
    const extension = image.fileName.includes(".")
      ? path.extname(image.fileName)
      : `.${output.extension}`;
    const fileName = `${Date.now()}-${randomUUID()}-${index + 1}${extension}`;
    const destination = path.join(artifactDir, fileName);
    await writeFile(destination, image.buffer);
    persisted.push({
      path: destination,
      mimeType: image.mimeType,
      bytes: image.buffer.byteLength,
      fileName,
      ...(image.revisedPrompt ? {revisedPrompt: image.revisedPrompt} : {}),
    });
  }

  return persisted;
}

export function toImageArtifact(image: PersistedGeneratedImage): ToolArtifactDescriptor {
  return {
    kind: "image",
    source: "image_generate",
    path: image.path,
    mimeType: image.mimeType,
    bytes: image.bytes,
  };
}

export function renderGeneratedImagesText(images: readonly PersistedGeneratedImage[]): string {
  return [
    `Generated ${images.length} image${images.length === 1 ? "" : "s"}.`,
    ...images.map((image, index) => `Image ${index + 1}: ${image.path}`),
  ].join("\n");
}

export function persistedImageDetails(images: readonly PersistedGeneratedImage[]): JsonObject[] {
  return images.map((image) => ({
    path: image.path,
    fileName: image.fileName,
    mimeType: image.mimeType,
    bytes: image.bytes,
    ...(image.revisedPrompt ? {revisedPrompt: image.revisedPrompt} : {}),
  }));
}
