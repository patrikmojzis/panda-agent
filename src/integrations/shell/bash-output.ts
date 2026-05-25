import {createWriteStream, type WriteStream} from "node:fs";
import {rm} from "node:fs/promises";
import {finished} from "node:stream/promises";

const BASH_NUL_PLACEHOLDER = "␀";
const TRUNCATION_HEAD_RATIO = 0.4;

interface PreviewBuffers {
  head: string;
  tail: string;
  totalChars: number;
}

export interface OutputCaptureState {
  preview: string;
  previewTruncated: boolean;
  totalChars: number;
  writer: WriteStream;
  filePath: string;
}

const previewBuffers = new WeakMap<OutputCaptureState, PreviewBuffers>();

/**
 * Postgres jsonb rejects JSON strings that contain \u0000. Keep bash output
 * previews human-readable while leaving raw persisted output files untouched.
 */
export function sanitizeBashOutputPreview(value: string): string {
  return value.includes("\0") ? value.replaceAll("\0", BASH_NUL_PLACEHOLDER) : value;
}

function normalizePreviewLimit(maxChars: number): number {
  if (!Number.isFinite(maxChars)) {
    return 0;
  }

  return Math.max(0, Math.floor(maxChars));
}

function appendHead(current: string, chunk: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  if (current.length >= maxChars) {
    return current.slice(0, maxChars);
  }

  return current + chunk.slice(0, maxChars - current.length);
}

function appendTail(current: string, chunk: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  if (chunk.length >= maxChars) {
    return chunk.slice(-maxChars);
  }

  const combined = current + chunk;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function markerLine(truncatedChars: number): string {
  return `…${String(truncatedChars)} chars truncated…`;
}

function markerBlock(truncatedChars: number): string {
  return `\n\n${markerLine(truncatedChars)}\n\n`;
}

function formatTruncatedPreview(buffers: PreviewBuffers, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  let marker = markerBlock(buffers.totalChars);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const availableChars = maxChars - marker.length;
    if (availableChars < 2) {
      const compactMarker = markerLine(buffers.totalChars);
      return compactMarker.length <= maxChars ? compactMarker : compactMarker.slice(0, maxChars);
    }

    const headChars = Math.floor(availableChars * TRUNCATION_HEAD_RATIO);
    const tailChars = availableChars - headChars;
    const truncatedChars = Math.max(0, buffers.totalChars - headChars - tailChars);
    const nextMarker = markerBlock(truncatedChars);
    if (nextMarker === marker) {
      return `${buffers.head.slice(0, headChars)}${marker}${tailString(buffers.tail, tailChars)}`;
    }

    marker = nextMarker;
  }

  const availableChars = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(availableChars * TRUNCATION_HEAD_RATIO);
  const tailChars = availableChars - headChars;
  const preview = `${buffers.head.slice(0, headChars)}${marker}${tailString(buffers.tail, tailChars)}`;
  return preview.length <= maxChars ? preview : preview.slice(0, maxChars);
}

function getPreviewBuffers(capture: OutputCaptureState, maxChars: number): PreviewBuffers {
  const existing = previewBuffers.get(capture);
  if (existing) {
    return existing;
  }

  const buffers = {
    head: capture.preview.slice(0, maxChars),
    tail: tailString(capture.preview, maxChars),
    totalChars: capture.preview.length,
  };
  previewBuffers.set(capture, buffers);
  return buffers;
}

export function tailString(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

export function createOutputCapture(filePath: string): OutputCaptureState {
  const capture = {
    preview: "",
    previewTruncated: false,
    totalChars: 0,
    writer: createWriteStream(filePath, { encoding: "utf8" }),
    filePath,
  };
  previewBuffers.set(capture, {
    head: "",
    tail: "",
    totalChars: 0,
  });
  return capture;
}

export function appendOutput(capture: OutputCaptureState, chunk: string, previewLimit: number): void {
  capture.totalChars += chunk.length;
  const maxPreviewChars = normalizePreviewLimit(previewLimit);
  const previewChunk = sanitizeBashOutputPreview(chunk);
  const buffers = getPreviewBuffers(capture, maxPreviewChars);
  buffers.totalChars += previewChunk.length;
  buffers.head = appendHead(buffers.head, previewChunk, maxPreviewChars);
  buffers.tail = appendTail(buffers.tail, previewChunk, maxPreviewChars);

  if (buffers.totalChars <= maxPreviewChars) {
    capture.preview = buffers.head;
  } else {
    capture.preview = formatTruncatedPreview(buffers, maxPreviewChars);
    capture.previewTruncated = true;
  }

  capture.writer.write(chunk);
}

export async function finalizeOutputCapture(options: {
  capture: OutputCaptureState;
  keepFile: boolean;
}): Promise<void> {
  options.capture.writer.end();
  await finished(options.capture.writer);

  if (!options.keepFile) {
    await rm(options.capture.filePath, { force: true });
  }
}
