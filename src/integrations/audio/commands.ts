import {readFile, stat} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import {trimToNull} from "../../lib/strings.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject} from "../../lib/json.js";
import type {CommandFileResolver} from "../../domain/commands/files.js";
import type {
  CommandDescriptor,
  CommandRequest,
  CommandSuccess,
  RegisteredCommand,
} from "../../domain/commands/types.js";
import {readResponseError} from "../../lib/http.js";

const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSLATION_ENDPOINT = "https://api.openai.com/v1/audio/translations";
const DEFAULT_MODEL = "whisper-1";
export const WHISPER_TRANSCRIBE_COMMAND_NAME = "whisper.transcribe";
export const WHISPER_TRANSLATE_COMMAND_NAME = "whisper.translate";
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

export interface WhisperAudioCommandOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const whisperTranscribeInputSchema = z.object({
  path: z.string().trim().min(1).describe(
    "Absolute path or path relative to the current working directory. In remote bash mode, agent-home runner paths are translated automatically.",
  ),
  language: z.string().trim().min(1).optional().describe("Optional ISO language code like 'en' or 'sk'."),
  prompt: z.string().trim().min(1).optional().describe("Optional prompt to bias tricky names, slang, or jargon."),
});

export const whisperTranslateInputSchema = z.object({
  path: z.string().trim().min(1).describe(
    "Absolute path or path relative to the current working directory. In remote bash mode, agent-home runner paths are translated automatically.",
  ),
  prompt: z.string().trim().min(1).optional().describe("Optional prompt to bias tricky names, slang, or jargon."),
});

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

function parseAudioTextPayload(
  value: unknown,
  operation: "transcribe" | "translate",
): {
  text: string;
  language: string | null;
  durationSeconds: number | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError(`OpenAI ${operation} response was not valid JSON.`);
  }

  const payload = value as Record<string, unknown>;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new ToolError(`OpenAI ${operation} response did not include text.`);
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
  return trimToNull(env.OPENAI_API_KEY) !== null;
}

export const whisperTranscribeCommandDescriptor: CommandDescriptor = {
  name: WHISPER_TRANSCRIBE_COMMAND_NAME,
  summary: "Transcribe a local audio file with Whisper.",
  description: "Transcribes one local audio file with OpenAI whisper-1 and returns transcript text plus metadata.",
  usage: "panda whisper transcribe <path> [--language <code>] [--prompt <text|@file|@->]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "path",
      description: "Audio file path, absolute or relative to the current working directory.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "language",
      description: "Optional ISO language code like en or sk.",
      valueType: "string",
      valueName: "code",
    },
    {
      name: "prompt",
      description: "Optional prompt to bias tricky names, slang, or jargon. Use @file or @- for longer text.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "json",
      description: "JSON object containing path, and optional language and prompt.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Transcribe an audio file",
      command: "panda whisper transcribe ./voice.mp3 --language sk",
    },
    {
      description: "Provide a vocabulary prompt from a file",
      command: "panda whisper transcribe ./voice.mp3 --prompt @terms.txt",
    },
    {
      description: "Use JSON input",
      command: "panda whisper transcribe --json '{\"path\":\"./voice.mp3\",\"language\":\"sk\"}'",
    },
  ],
  requiredCapabilities: [WHISPER_TRANSCRIBE_COMMAND_NAME],
  resultShape: {
    text: "string",
    provider: "openai",
    model: "whisper-1",
    path: "string",
    originalPath: "string",
    mimeType: "string",
    sizeBytes: "number",
    language: "string|null",
    durationSeconds: "number|null",
    transcriptChars: "number",
  },
};

export const whisperTranslateCommandDescriptor: CommandDescriptor = {
  name: WHISPER_TRANSLATE_COMMAND_NAME,
  summary: "Translate a local audio file to English with Whisper.",
  description: "Translates one local audio file into English text with OpenAI whisper-1 and returns translation text plus metadata.",
  usage: "panda whisper translate <path> [--prompt <text|@file|@->]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "path",
      description: "Audio file path, absolute or relative to the current working directory.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "prompt",
      description: "Optional prompt to bias tricky names, slang, or jargon. Use @file or @- for longer text.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "json",
      description: "JSON object containing path and optional prompt.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Translate an audio file to English",
      command: "panda whisper translate ./voice.mp3",
    },
    {
      description: "Provide a vocabulary prompt from a file",
      command: "panda whisper translate ./voice.mp3 --prompt @terms.txt",
    },
    {
      description: "Use JSON input",
      command: "panda whisper translate --json '{\"path\":\"./voice.mp3\"}'",
    },
  ],
  requiredCapabilities: [WHISPER_TRANSLATE_COMMAND_NAME],
  resultShape: {
    text: "string",
    provider: "openai",
    model: "whisper-1",
    path: "string",
    originalPath: "string",
    mimeType: "string",
    sizeBytes: "number",
    targetLanguage: "en",
    elapsedMs: "number",
    translationChars: "number",
  },
};

async function runWhisperAudioFile(params: {
  filePath: string;
  originalPath: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  endpoint: string;
  operation: "transcribe" | "translate";
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
  emitProgress?: (progress: JsonObject) => void;
}): Promise<{
  text: string;
  details: JsonObject;
}> {
  const sizeBytes = await ensureReadableFile(params.filePath);
  const fileName = path.basename(params.filePath);
  const mimeType = inferMimeType(params.filePath);
  const bytes = await readFile(params.filePath);

  const body = new FormData();
  body.append("file", new Blob([bytes], { type: mimeType }), fileName);
  body.append("model", DEFAULT_MODEL);
  body.append("response_format", "json");
  if (params.language) {
    body.append("language", params.language);
  }
  if (params.prompt) {
    body.append("prompt", params.prompt);
  }

  const progressStatus = params.operation === "translate" ? "translating" : "transcribing";
  params.emitProgress?.({
    status: progressStatus,
    model: DEFAULT_MODEL,
    path: params.filePath,
    sizeBytes,
  });

  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const startedAt = Date.now();

  try {
    const response = await params.fetchImpl(params.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      body,
      signal,
    });

    if (!response.ok) {
      const detail = await readResponseError(response, MAX_ERROR_CHARS);
      throw new ToolError(
        `OpenAI ${params.operation} API error (${response.status}): ${detail || response.statusText}`,
      );
    }

    const audioText = parseAudioTextPayload(await response.json(), params.operation);
    const textLengthKey = params.operation === "translate" ? "translationChars" : "transcriptChars";
    return {
      text: audioText.text,
      details: {
        provider: "openai",
        model: DEFAULT_MODEL,
        path: params.filePath,
        originalPath: params.originalPath,
        mimeType,
        sizeBytes,
        elapsedMs: Date.now() - startedAt,
        language: audioText.language,
        durationSeconds: audioText.durationSeconds,
        [textLengthKey]: audioText.text.length,
      },
    };
  } catch (error) {
    if (params.signal?.aborted) {
      throw new ToolError(`Whisper ${params.operation} was aborted.`);
    }
    if (timeoutSignal.aborted) {
      throw new ToolError(`Whisper ${params.operation} timed out after ${params.timeoutMs}ms.`);
    }
    if (error instanceof ToolError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Whisper ${params.operation} failed: ${message}`);
  }
}

export function createWhisperTranscribeCommand(
  options: WhisperAudioCommandOptions = {},
  fileResolver?: CommandFileResolver,
): RegisteredCommand {
  return createTranscribeCommand(options, fileResolver);
}

export function createWhisperTranslateCommand(
  options: WhisperAudioCommandOptions = {},
  fileResolver?: CommandFileResolver,
): RegisteredCommand {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    descriptor: whisperTranslateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const args = whisperTranslateInputSchema.parse(request.input);
      const apiKey = trimToNull(options.apiKey) ?? trimToNull(env.OPENAI_API_KEY);
      if (!apiKey) {
        throw new ToolError("OPENAI_API_KEY is not configured.");
      }

      const resolved = fileResolver
        ? await fileResolver.resolveReadablePath({
          request,
          file: {
            path: args.path,
          },
        })
        : {path: args.path};
      const translation = await runWhisperAudioFile({
        filePath: resolved.path,
        originalPath: args.path,
        apiKey,
        fetchImpl,
        timeoutMs,
        endpoint: OPENAI_TRANSLATION_ENDPOINT,
        operation: "translate",
        prompt: args.prompt,
      });
      const output = {
        text: translation.text,
        ...translation.details,
        targetLanguage: "en",
      };

      return {
        ok: true,
        command: WHISPER_TRANSLATE_COMMAND_NAME,
        output,
        summary: `Translated ${args.path} to English.`,
      };
    },
  };
}

function createTranscribeCommand(
  options: WhisperAudioCommandOptions = {},
  fileResolver?: CommandFileResolver,
): RegisteredCommand {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    descriptor: whisperTranscribeCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const args = whisperTranscribeInputSchema.parse(request.input);
      const apiKey = trimToNull(options.apiKey) ?? trimToNull(env.OPENAI_API_KEY);
      if (!apiKey) {
        throw new ToolError("OPENAI_API_KEY is not configured.");
      }

      const resolved = fileResolver
        ? await fileResolver.resolveReadablePath({
          request,
          file: {
            path: args.path,
          },
        })
        : {path: args.path};
      const transcript = await runWhisperAudioFile({
        filePath: resolved.path,
        originalPath: args.path,
        apiKey,
        fetchImpl,
        timeoutMs,
        endpoint: OPENAI_TRANSCRIPTION_ENDPOINT,
        operation: "transcribe",
        language: args.language,
        prompt: args.prompt,
      });
      const output = {
        text: transcript.text,
        ...transcript.details,
      };

      return {
        ok: true,
        command: WHISPER_TRANSCRIBE_COMMAND_NAME,
        output,
        summary: `Transcribed ${args.path}.`,
      };
    },
  };
}
