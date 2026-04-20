import type {Message, ToolResultMessage} from "@mariozechner/pi-ai";

import {estimateTokensFromString, type TokenCounter} from "../agent/helpers/token-count.js";
import {readToolArtifact} from "../agent/tool-artifacts.js";
import type {JsonValue} from "../agent/types.js";
import {clamp, readPositiveInteger} from "../../lib/numbers.js";

const MIN_IMAGE_TOKENS = 85;
const MAX_IMAGE_TOKENS = 1_600;
const FALLBACK_IMAGE_TOKENS = 1_200;
const IMAGE_PIXELS_PER_TOKEN = 800;

type ToolArtifactImageMode = "inlineOnly" | "replay";

interface ImageDimensions {
  width?: number;
  height?: number;
}

function estimateStructuredValueTokens(value: unknown, estimateTextTokens: TokenCounter): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value === "string") {
    return estimateTextTokens(value);
  }

  return estimateTextTokens(JSON.stringify(value));
}

function decodeBase64Prefix(data: string, maxBytes: number): Buffer | null {
  const trimmed = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const charsNeeded = Math.ceil(maxBytes / 3) * 4;

  try {
    return Buffer.from(trimmed.slice(0, charsNeeded), "base64");
  } catch {
    return null;
  }
}

function readPngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return null;
  }

  return {
    width: readPositiveInteger(bytes.readUInt32BE(16)),
    height: readPositiveInteger(bytes.readUInt32BE(20)),
  };
}

function readGifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) {
    return null;
  }

  const signature = bytes.subarray(0, 6).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }

  return {
    width: readPositiveInteger(bytes.readUInt16LE(6)),
    height: readPositiveInteger(bytes.readUInt16LE(8)),
  };
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xFF) {
      offset += 1;
    }

    if (offset >= bytes.length) {
      return null;
    }

    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0xD9 || marker === 0xDA) {
      return null;
    }

    if (offset + 2 > bytes.length) {
      return null;
    }

    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }

    const isStartOfFrame = (
      (marker >= 0xC0 && marker <= 0xC3)
      || (marker >= 0xC5 && marker <= 0xC7)
      || (marker >= 0xC9 && marker <= 0xCB)
      || (marker >= 0xCD && marker <= 0xCF)
    );

    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: readPositiveInteger(bytes.readUInt16BE(offset + 3)),
        width: readPositiveInteger(bytes.readUInt16BE(offset + 5)),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function sniffInlineImageDimensions(data: string): ImageDimensions | null {
  const bytes = decodeBase64Prefix(data, 4_096);
  if (!bytes) {
    return null;
  }

  return readPngDimensions(bytes)
    ?? readGifDimensions(bytes)
    ?? readJpegDimensions(bytes);
}

function estimateImageTokensFromDimensions(dimensions?: ImageDimensions | null): number {
  const width = readPositiveInteger(dimensions?.width);
  const height = readPositiveInteger(dimensions?.height);
  if (!width || !height) {
    return FALLBACK_IMAGE_TOKENS;
  }

  return clamp(Math.ceil((width * height) / IMAGE_PIXELS_PER_TOKEN), MIN_IMAGE_TOKENS, MAX_IMAGE_TOKENS);
}

function estimateInlineImageTokens(block: {data: string}, dimensions?: ImageDimensions | null): number {
  return estimateImageTokensFromDimensions(dimensions ?? sniffInlineImageDimensions(block.data));
}

function estimateAssistantMessageTokens(
  message: Extract<Message, {role: "assistant"}>,
  estimateTextTokens: TokenCounter,
): number {
  return message.content.reduce((total, block) => {
    if (block.type === "text") {
      return total + estimateTextTokens(block.text);
    }

    if (block.type === "thinking") {
      if (block.thinkingSignature?.trim()) {
        return total + estimateTextTokens(block.thinkingSignature);
      }

      return total + estimateTextTokens(block.thinking);
    }

    if (block.type === "toolCall") {
      return total
        + estimateTextTokens(block.id)
        + estimateTextTokens(block.name)
        + estimateStructuredValueTokens(block.arguments, estimateTextTokens)
        + estimateStructuredValueTokens(block.thoughtSignature, estimateTextTokens);
    }

    return total;
  }, 0);
}

function estimateUserMessageTokens(
  message: Extract<Message, {role: "user"}>,
  estimateTextTokens: TokenCounter,
): number {
  if (typeof message.content === "string") {
    return estimateTextTokens(message.content);
  }

  return message.content.reduce((total, block) => {
    if (block.type === "text") {
      return total + estimateTextTokens(block.text);
    }

    if (block.type === "image") {
      return total + estimateInlineImageTokens(block);
    }

    return total;
  }, 0);
}

function estimateArtifactImageTokens(message: ToolResultMessage<JsonValue>): number {
  const artifact = readToolArtifact(message.details);
  if (!artifact) {
    return 0;
  }

  if (artifact.kind === "image") {
    return estimateImageTokensFromDimensions(artifact);
  }

  if (artifact.kind === "pdf" && artifact.preview) {
    return estimateImageTokensFromDimensions(artifact.preview);
  }

  return 0;
}

function estimateToolResultTokens(
  message: ToolResultMessage<JsonValue>,
  estimateTextTokens: TokenCounter,
  artifactImageMode: ToolArtifactImageMode,
): number {
  let hasInlineImage = false;
  const tokens = message.content.reduce((total, block) => {
    if (block.type === "text") {
      return total + estimateTextTokens(block.text);
    }

    if (block.type === "image") {
      hasInlineImage = true;
      return total + estimateInlineImageTokens(block);
    }

    return total;
  }, 0);

  return tokens
    + estimateTextTokens(message.toolCallId)
    + estimateTextTokens(message.toolName)
    + (hasInlineImage || artifactImageMode !== "replay" ? 0 : estimateArtifactImageTokens(message));
}

function estimateMessageTokens(
  message: Message,
  estimateTextTokens: TokenCounter,
  artifactImageMode: ToolArtifactImageMode,
): number {
  switch (message.role) {
    case "user":
      return Math.max(1, estimateUserMessageTokens(message, estimateTextTokens));
    case "assistant":
      return Math.max(1, estimateAssistantMessageTokens(message, estimateTextTokens));
    case "toolResult":
      return Math.max(1, estimateToolResultTokens(message, estimateTextTokens, artifactImageMode));
    default:
      return Math.max(1, estimateStructuredValueTokens(message, estimateTextTokens));
  }
}

export function estimateVisibleMessageTokens(
  message: Message,
  estimateTextTokens: TokenCounter = estimateTokensFromString,
): number {
  return estimateMessageTokens(message, estimateTextTokens, "inlineOnly");
}

// Replay estimation assumes projected tool artifacts will be rehydrated before send.
export function estimateReplayMessageTokens(
  message: Message,
  estimateTextTokens: TokenCounter = estimateTokensFromString,
): number {
  return estimateMessageTokens(message, estimateTextTokens, "replay");
}
