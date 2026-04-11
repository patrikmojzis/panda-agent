import {readFile, stat} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import {Tool} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {JsonObject, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";
import {resolvePandaPath} from "./context.js";

const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_ERROR_CHARS = 4_000;
const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".flac", "audio/flac"],
  [".m4a", "audio/m4a"],
  [".mp3", "audio/mpeg"],
  [".mp4", "audio/mp4"],
  [".mpeg", "audio/mpeg"],
  [".mpga", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
]);

export interface WhisperToolOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

async function readResponseError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return truncateText(text, MAX_ERROR_CHARS);
}

async function ensureReadableFile(filePath: string): Promise<number> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new ToolError(`No readable file found at ${filePath}`);
  }

  if (!fileStat.isFile()) {
    throw new ToolError(`Expected a file at ${filePath}`);
  }

  if (fileStat.size > MAX_AUDIO_BYTES) {
    throw new ToolError(
      `Audio file at ${filePath} is ${fileStat.size} bytes. OpenAI whisper-1 accepts files up to 25 MB.`,
    );
  }

  return fileStat.size;
}

function inferMimeType(filePath: string): string {
  return MIME_TYPES_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function parseTranscriptPayload(
  value: unknown,
): {
  text: string;
  language: string | null;
  durationSeconds: number | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("OpenAI transcription response was not valid JSON.");
  }

  const payload = value as Record<string, unknown>;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new ToolError("OpenAI transcription response did not include transcript text.");
  }

  return {
    text,
    language: typeof payload.language === "string" && payload.language.trim()
      ? payload.language.trim()
      : null,
    durationSeconds: typeof payload.duration === "number" ? payload.duration : null,
  };
}

export function hasOpenAiApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return trimNonEmptyString(env.OPENAI_API_KEY) !== null;
}

export class WhisperTool<TContext = PandaSessionContext> extends Tool<typeof WhisperTool.schema, TContext> {
  static schema = z.object({
    path: z.string().trim().min(1).describe("Absolute path or path relative to the current working directory."),
    language: z.string().trim().min(1).optional().describe("Optional ISO language code like 'en' or 'sk'."),
    prompt: z.string().trim().min(1).optional().describe("Optional prompt to bias tricky names, slang, or jargon."),
  });

  name = "whisper";
  description = "Transcribe a local audio file to text with OpenAI whisper-1.";
  schema = WhisperTool.schema;

  private readonly apiKey?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WhisperToolOptions = {}) {
    super();
    this.apiKey = trimNonEmptyString(options.apiKey) ?? undefined;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.path === "string" ? args.path : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof WhisperTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const apiKey = this.apiKey ?? trimNonEmptyString(this.env.OPENAI_API_KEY);
    if (!apiKey) {
      throw new ToolError("OPENAI_API_KEY is not configured.");
    }

    const resolvedPath = resolvePandaPath(args.path, run.context);
    const sizeBytes = await ensureReadableFile(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const mimeType = inferMimeType(resolvedPath);
    const bytes = await readFile(resolvedPath);

    const body = new FormData();
    body.append("file", new Blob([bytes], { type: mimeType }), fileName);
    body.append("model", DEFAULT_MODEL);
    body.append("response_format", "json");
    if (args.language) {
      body.append("language", args.language);
    }
    if (args.prompt) {
      body.append("prompt", args.prompt);
    }

    run.emitToolProgress({
      status: "transcribing",
      model: DEFAULT_MODEL,
      path: resolvedPath,
      sizeBytes,
    });

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = run.signal ? AbortSignal.any([run.signal, timeoutSignal]) : timeoutSignal;
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(OPENAI_TRANSCRIPTION_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal,
      });

      if (!response.ok) {
        const detail = await readResponseError(response);
        throw new ToolError(
          `OpenAI transcription API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const transcript = parseTranscriptPayload(await response.json());
      const details: JsonObject = {
        provider: "openai",
        model: DEFAULT_MODEL,
        path: resolvedPath,
        originalPath: args.path,
        mimeType,
        sizeBytes,
        elapsedMs: Date.now() - startedAt,
        language: transcript.language,
        durationSeconds: transcript.durationSeconds,
        transcriptChars: transcript.text.length,
      };

      return {
        content: [
          {
            type: "text",
            text: `Transcript:\n${transcript.text}`,
          },
        ],
        details,
      };
    } catch (error) {
      if (run.signal?.aborted) {
        throw new ToolError("Whisper transcription was aborted.");
      }
      if (timeoutSignal.aborted) {
        throw new ToolError(`Whisper transcription timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof ToolError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Whisper transcription failed: ${message}`);
    }
  }
}
