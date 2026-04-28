import type {JsonObject} from "../../kernel/agent/types.js";

const SUMMARY_PREVIEW_CHARS = 360;
const ERROR_PREVIEW_CHARS = 480;
const RESULT_PREVIEW_CHARS = 1_000;
const FINAL_MESSAGE_PREVIEW_CHARS = 1_400;
const OUTPUT_PREVIEW_CHARS = 400;

function truncatePreview(value: string | undefined, maxChars: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function readText(value: JsonObject | undefined, key: string): string {
  const next = value?.[key];
  return typeof next === "string" ? next.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    `Summary: ${truncatePreview(options.summary, SUMMARY_PREVIEW_CHARS)}`,
  ];

  if (options.durationMs !== undefined) {
    lines.push(`Duration: ${options.durationMs}ms`);
  }

  if (options.error) {
    lines.push(`Error: ${truncatePreview(options.error, ERROR_PREVIEW_CHARS)}`);
  }

  if (options.reason) {
    lines.push(`Reason: ${truncatePreview(options.reason, ERROR_PREVIEW_CHARS)}`);
  }

  const contentText = readText(options.result, "contentText");
  const imagePaths = options.kind === "image_generate" ? readImagePaths(options.result) : [];
  if (imagePaths.length > 0) {
    lines.push([
      "Generated images:",
      ...imagePaths.map((imagePath, index) => `Image ${index + 1}: ${imagePath}`),
    ].join("\n"));
  } else if (contentText) {
    lines.push(`Result:\n${truncatePreview(contentText, RESULT_PREVIEW_CHARS)}`);
  }

  const finalMessage = readText(options.result, "finalMessage");
  if (finalMessage) {
    lines.push(`Final message:\n${truncatePreview(finalMessage, FINAL_MESSAGE_PREVIEW_CHARS)}`);
  }

  const stdout = readText(options.result, "stdout");
  if (stdout) {
    lines.push(`stdout preview:\n${truncatePreview(stdout, OUTPUT_PREVIEW_CHARS)}`);
  }

  const stderr = readText(options.result, "stderr");
  if (stderr) {
    lines.push(`stderr preview:\n${truncatePreview(stderr, OUTPUT_PREVIEW_CHARS)}`);
  }

  return lines.join("\n");
}
