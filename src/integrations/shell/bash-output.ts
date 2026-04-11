import {createWriteStream, type WriteStream} from "node:fs";
import {rm} from "node:fs/promises";
import {finished} from "node:stream/promises";

interface CapturedOutput {
  value: string;
  truncated: boolean;
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
  const next = appendChunk(capture.preview, chunk, previewLimit);
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
