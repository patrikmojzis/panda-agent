import {randomUUID} from "node:crypto";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {ResolvedCommandReadableFile} from "../../domain/commands/files.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {ToolArtifactDescriptor} from "../../kernel/agent/tool-artifacts.js";
import type {JsonObject} from "../../lib/json.js";
import {
  type GeneratedOpenAIImage,
  type OpenAIImageInputImage,
  type OpenAIImageOutputFormat,
  resolveOpenAIImageMime,
} from "../../integrations/providers/openai-image/client.js";
import {resolveToolArtifactMediaRoot, resolveToolArtifactScopeKey} from "../tools/artifact-paths.js";

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

/** Read authorized resolver snapshots; their Core paths are not agent-visible paths. */
export async function loadReferenceImages(
  files: readonly ResolvedCommandReadableFile[],
): Promise<readonly OpenAIImageInputImage[]> {
  const images: OpenAIImageInputImage[] = [];
  for (const file of files) {
    const mimeType = inferReferenceMimeType(file.path);
    await ensureReadableReferenceImage(file.path);
    images.push({
      fileName: path.basename(file.displayPath),
      mimeType,
      buffer: await readFile(file.path),
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
  const root = resolveToolArtifactMediaRoot({
    context: params.context,
    env: params.env,
    source: "image",
  });
  const artifactDir = path.join(root, "image-generation", resolveToolArtifactScopeKey(params.context));
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
