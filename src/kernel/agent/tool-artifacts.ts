import {readFile} from "node:fs/promises";

import type {ToolResultMessage} from "@mariozechner/pi-ai";

import {readNonNegativeNumber, readPositiveInteger} from "../../lib/numbers.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import type {JsonObject, JsonValue} from "./types.js";

export interface ToolArtifactPreview {
  kind: "image";
  path: string;
  mimeType: string;
  bytes?: number;
  width?: number;
  height?: number;
}

export interface ToolArtifactDescriptor {
  kind: "image" | "pdf";
  source: "browser" | "view_media";
  path: string;
  mimeType: string;
  bytes?: number;
  width?: number;
  height?: number;
  originalPath?: string;
  preview?: ToolArtifactPreview;
}

export function readToolArtifact(details: JsonValue | undefined): ToolArtifactDescriptor | null {
  if (!isRecord(details) || !isRecord(details.artifact)) {
    return null;
  }

  const artifact = details.artifact;
  const kind = artifact.kind === "image" || artifact.kind === "pdf" ? artifact.kind : null;
  const source = artifact.source === "browser" || artifact.source === "view_media" ? artifact.source : null;
  const path = trimToNull(artifact.path);
  const mimeType = trimToNull(artifact.mimeType);

  if (!kind || !source || !path || !mimeType) {
    return null;
  }

  let preview: ToolArtifactPreview | undefined;
  if (isRecord(artifact.preview)) {
    const previewPath = trimToNull(artifact.preview.path);
    const previewMimeType = trimToNull(artifact.preview.mimeType);
    const previewBytes = readNonNegativeNumber(artifact.preview.bytes);
    const previewWidth = readPositiveInteger(artifact.preview.width);
    const previewHeight = readPositiveInteger(artifact.preview.height);
    if (artifact.preview.kind === "image" && previewPath && previewMimeType) {
      preview = {
        kind: "image",
        path: previewPath,
        mimeType: previewMimeType,
        ...(previewBytes !== undefined ? {bytes: previewBytes} : {}),
        ...(previewWidth !== undefined ? {width: previewWidth} : {}),
        ...(previewHeight !== undefined ? {height: previewHeight} : {}),
      };
    }
  }

  const artifactBytes = readNonNegativeNumber(artifact.bytes);
  const artifactWidth = readPositiveInteger(artifact.width);
  const artifactHeight = readPositiveInteger(artifact.height);
  const originalPath = trimToNull(artifact.originalPath);

  return {
    kind,
    source,
    path,
    mimeType,
    ...(artifactBytes !== undefined ? {bytes: artifactBytes} : {}),
    ...(artifactWidth !== undefined ? {width: artifactWidth} : {}),
    ...(artifactHeight !== undefined ? {height: artifactHeight} : {}),
    ...(originalPath ? {originalPath} : {}),
    ...(preview ? {preview} : {}),
  };
}

export function stripToolArtifactInlineImages(
  message: ToolResultMessage<JsonValue>,
): ToolResultMessage<JsonValue> {
  if (!readToolArtifact(message.details)) {
    return message;
  }

  const content = message.content.filter((part) => part.type !== "image");
  if (content.length === message.content.length) {
    return message;
  }

  return {
    ...message,
    content,
  };
}

function hasInlineImage(message: ToolResultMessage<JsonValue>): boolean {
  return message.content.some((part) => part.type === "image");
}

async function buildImageContentBlock(path: string, mimeType: string): Promise<{
  type: "image";
  data: string;
  mimeType: string;
} | null> {
  try {
    const bytes = await readFile(path);
    return {
      type: "image",
      data: bytes.toString("base64"),
      mimeType,
    };
  } catch {
    return null;
  }
}

export async function rehydrateToolArtifactMessage(
  message: ToolResultMessage<JsonValue>,
): Promise<ToolResultMessage<JsonValue>> {
  if (hasInlineImage(message)) {
    return message;
  }

  const artifact = readToolArtifact(message.details);
  if (!artifact) {
    return message;
  }

  const imageSource = artifact.kind === "image"
    ? {path: artifact.path, mimeType: artifact.mimeType}
    : artifact.preview
      ? {path: artifact.preview.path, mimeType: artifact.preview.mimeType}
      : null;

  if (!imageSource) {
    return message;
  }

  const image = await buildImageContentBlock(imageSource.path, imageSource.mimeType);
  if (!image) {
    return message;
  }

  return {
    ...message,
    content: [
      ...message.content,
      image,
    ],
  };
}

export function withArtifactDetails(
  details: JsonObject,
  artifact: ToolArtifactDescriptor,
): JsonObject {
  return {
    ...details,
    artifact: artifact as unknown as JsonValue,
  };
}
