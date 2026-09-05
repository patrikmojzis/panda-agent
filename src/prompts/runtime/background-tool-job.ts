import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {truncateText} from "../../lib/strings.js";

const SUMMARY_PREVIEW_CHARS = 360;
const ERROR_PREVIEW_CHARS = 480;
const RESULT_PREVIEW_CHARS = 1_000;
const FINAL_MESSAGE_PREVIEW_CHARS = 1_400;
const OUTPUT_PREVIEW_CHARS = 400;

function readText(value: JsonObject | undefined, key: string): string {
  const next = value?.[key];
  return typeof next === "string" ? next.trim() : "";
}

function readImagePaths(result: JsonObject | undefined): string[] {
  const details = isRecord(result?.details) ? result.details : null;
  const images = Array.isArray(details?.images) ? details.images : [];
  return images.flatMap((image) => {
    if (!isRecord(image) || typeof image.path !== "string" || !image.path.trim()) {
      return [];
    }

    return [image.path.trim()];
  });
}

export function renderBackgroundToolJobEventPrompt(options: {
  jobId: string;
  kind: string;
  status: string;
  summary: string;
  durationMs?: number;
  result?: JsonObject;
  error?: string;
  reason?: string;
}): string {
  const lines = [
    "[Background Tool Event]",
    `Job ID: ${options.jobId}`,
    `Kind: ${options.kind}`,
    `Status: ${options.status}`,
    `Summary: ${truncateText((options.summary ?? "").trim(), SUMMARY_PREVIEW_CHARS)}`,
  ];

  if (options.durationMs !== undefined) {
    lines.push(`Duration: ${options.durationMs}ms`);
  }

  if (options.error) {
    lines.push(`Error: ${truncateText((options.error ?? "").trim(), ERROR_PREVIEW_CHARS)}`);
  }

  if (options.reason) {
    lines.push(`Reason: ${truncateText((options.reason ?? "").trim(), ERROR_PREVIEW_CHARS)}`);
  }

  const contentText = readText(options.result, "contentText");
  const imagePaths = options.kind === "image_generate" ? readImagePaths(options.result) : [];
  if (imagePaths.length > 0) {
    lines.push([
      "Generated images:",
      ...imagePaths.map((imagePath, index) => `Image ${index + 1}: ${imagePath}`),
    ].join("\n"));
  } else if (contentText) {
    lines.push(`Result:\n${truncateText(contentText, RESULT_PREVIEW_CHARS)}`);
  }

  const finalMessage = readText(options.result, "finalMessage");
  if (finalMessage) {
    lines.push(`Final message:\n${truncateText(finalMessage, FINAL_MESSAGE_PREVIEW_CHARS)}`);
  }

  const stdout = readText(options.result, "stdout");
  if (stdout) {
    lines.push(`stdout preview:\n${truncateText(stdout, OUTPUT_PREVIEW_CHARS)}`);
  }

  const stderr = readText(options.result, "stderr");
  if (stderr) {
    lines.push(`stderr preview:\n${truncateText(stderr, OUTPUT_PREVIEW_CHARS)}`);
  }

  return lines.join("\n");
}
