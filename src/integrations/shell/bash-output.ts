import {createWriteStream, type WriteStream} from "node:fs";
import {rm} from "node:fs/promises";
import {finished} from "node:stream/promises";

interface CapturedOutput {
  value: string;
  truncated: boolean;
}

const BASH_NUL_PLACEHOLDER = "␀";

/**
 * Postgres jsonb rejects JSON strings that contain \u0000. Keep bash output
 * previews human-readable while leaving raw persisted output files untouched.
 */
export function sanitizeBashOutputPreview(value: string): string {
  return value.includes("\0") ? value.replaceAll("\0", BASH_NUL_PLACEHOLDER) : value;
}

export interface OutputCaptureState {
  preview: string;
  previewTruncated: boolean;
  totalChars: number;
  writer: WriteStream;
  filePath: string;
}

function appendChunk(current: string, chunk: string, maxChars: number): CapturedOutput {
  if (current.length >= maxChars) {
    return {
      value: current,
      truncated: true,
    };
  }

  const remaining = maxChars - current.length;
  if (chunk.length <= remaining) {
    return {
      value: current + chunk,
      truncated: false,
    };
  }

  return {
    value: current + chunk.slice(0, remaining),
    truncated: true,
  };
}

export function tailString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

export function createOutputCapture(filePath: string): OutputCaptureState {
  return {
    preview: "",
    previewTruncated: false,
    totalChars: 0,
    writer: createWriteStream(filePath, { encoding: "utf8" }),
    filePath,
  };
}

export function appendOutput(capture: OutputCaptureState, chunk: string, previewLimit: number): void {
  capture.totalChars += chunk.length;
  const previewChunk = sanitizeBashOutputPreview(chunk);
  const next = appendChunk(capture.preview, previewChunk, previewLimit);
  capture.preview = next.value;
  capture.previewTruncated ||= next.truncated;
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
