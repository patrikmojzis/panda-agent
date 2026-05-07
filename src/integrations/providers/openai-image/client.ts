import {resolveOpenAICodexOauthToken} from "../shared/auth.js";
import {trimToNull} from "../../../lib/strings.js";

export type OpenAIImageAuthKind = "codex-oauth" | "openai-api-key";
export type OpenAIImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAIImageQuality = "low" | "medium" | "high" | "auto";
export type OpenAIImageBackground = "transparent" | "opaque" | "auto";
export type OpenAIImageModeration = "low" | "auto";

export interface OpenAIImageInputImage {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface GenerateOpenAIImageRequest {
  prompt: string;
  images?: readonly OpenAIImageInputImage[];
  model: string;
  size: string;
  quality: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
  background: OpenAIImageBackground;
  moderation: OpenAIImageModeration;
  count: number;
  outputCompression?: number;
  signal?: AbortSignal;
}

export interface GeneratedOpenAIImage {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  revisedPrompt?: string;
}

export interface GenerateOpenAIImageResult {
  provider: "openai";
  authKind: OpenAIImageAuthKind;
  model: string;
  responsesModel?: string;
  images: readonly GeneratedOpenAIImage[];
}

export interface OpenAIImageClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_IMAGE_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_RESPONSES_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 420_000;
const MAX_ERROR_CHARS = 4_000;
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;

type OpenAIImageAuth =
  | { kind: "codex-oauth"; token: string }
  | { kind: "openai-api-key"; token: string };

type OpenAIImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
};

type OpenAICodexImageGenerationEvent = {
  type?: string;
  item?: {
    type?: string;
    result?: string;
    revised_prompt?: string;
  };
  response?: {
    output?: Array<{
      type?: string;
      result?: string;
      revised_prompt?: string;
    }>;
  };
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
};

function isEnabledEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function isOpenAIImageApiKeyFallbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnv(env.PANDA_IMAGE_ALLOW_OPENAI_API_KEY);
}

export function resolveOpenAIImageAuth(env: NodeJS.ProcessEnv = process.env): OpenAIImageAuth {
  const codexToken = resolveOpenAICodexOauthToken({env});
  if (codexToken) {
    return {kind: "codex-oauth", token: codexToken};
  }

  const apiKey = trimToNull(env.OPENAI_API_KEY);
  if (apiKey && isOpenAIImageApiKeyFallbackAllowed(env)) {
    return {kind: "openai-api-key", token: apiKey};
  }

  if (apiKey) {
    throw new Error(
      "Missing OpenAI Codex OAuth token. OPENAI_API_KEY fallback requires PANDA_IMAGE_ALLOW_OPENAI_API_KEY=true.",
    );
  }

  throw new Error("Missing OpenAI Codex OAuth token. Run `codex login` or set OPENAI_OAUTH_TOKEN.");
}

export function resolveOpenAIImageMime(outputFormat: OpenAIImageOutputFormat): {
  mimeType: string;
  extension: string;
} {
  switch (outputFormat) {
    case "jpeg":
      return {mimeType: "image/jpeg", extension: "jpg"};
    case "webp":
      return {mimeType: "image/webp", extension: "webp"};
    case "png":
      return {mimeType: "image/png", extension: "png"};
  }
}

function appendImageOptions(target: Record<string, unknown> | FormData, request: GenerateOpenAIImageRequest): void {
  const entries: Record<string, unknown> = {
    quality: request.quality,
    output_format: request.outputFormat,
    background: request.background,
    moderation: request.moderation,
    ...(request.outputCompression !== undefined ? {output_compression: request.outputCompression} : {}),
  };

  for (const [key, value] of Object.entries(entries)) {
    if (target instanceof FormData) {
      target.set(key, String(value));
    } else {
      target[key] = value;
    }
  }
}

function toUploadBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
  } catch {
    return "";
  }
}

async function assertOk(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const detail = await readResponseError(response);
  throw new Error(`${label} (${response.status}): ${detail || response.statusText}`);
}

function toDataUrl(image: OpenAIImageInputImage): string {
  return `data:${image.mimeType};base64,${image.buffer.toString("base64")}`;
}

async function readResponseBodyText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CODEX_IMAGE_SSE_BYTES) {
      throw new Error("OpenAI Codex image generation response exceeded size limit.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const {value, done} = await reader.read();
      if (value) {
        byteLength += value.byteLength;
        if (byteLength > MAX_CODEX_IMAGE_SSE_BYTES) {
          throw new Error("OpenAI Codex image generation response exceeded size limit.");
        }
        chunks.push(decoder.decode(value, {stream: !done}));
      }
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        return chunks.join("");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseCodexImageGenerationEvents(body: string): OpenAICodexImageGenerationEvent[] {
  const events: OpenAICodexImageGenerationEvent[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      events.push(JSON.parse(data) as OpenAICodexImageGenerationEvent);
    } catch {
      continue;
    }

    if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) {
      throw new Error("OpenAI Codex image generation response exceeded event limit.");
    }
  }
  return events;
}

function decodeCodexImagePayload(payload: string): Buffer {
  if (payload.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error("OpenAI Codex image generation result exceeded size limit.");
  }
  return Buffer.from(payload, "base64");
}

function codexEntryToImage(
  entry: {result?: string; revised_prompt?: string},
  index: number,
  outputFormat: OpenAIImageOutputFormat,
): GeneratedOpenAIImage | null {
  if (!entry.result) {
    return null;
  }

  const output = resolveOpenAIImageMime(outputFormat);
  return {
    buffer: decodeCodexImagePayload(entry.result),
    mimeType: output.mimeType,
    fileName: `image-${index + 1}.${output.extension}`,
    ...(entry.revised_prompt ? {revisedPrompt: entry.revised_prompt} : {}),
  };
}

function parseCodexImageGenerationResult(
  body: string,
  outputFormat: OpenAIImageOutputFormat,
): readonly GeneratedOpenAIImage[] {
  const events = parseCodexImageGenerationEvents(body);
  const failure = events.find((event) => event.type === "response.failed" || event.type === "error");
  if (failure) {
    const message =
      failure.error?.message
      ?? failure.message
      ?? (failure.error?.code ? `OpenAI Codex image generation failed (${failure.error.code})` : "");
    throw new Error(message || "OpenAI Codex image generation failed.");
  }

  const completedResponse = events.find((event) => event.type === "response.completed");
  const outputItemImages = events
    .filter((event) =>
      event.type === "response.output_item.done"
      && event.item?.type === "image_generation_call"
      && typeof event.item.result === "string"
      && event.item.result.length > 0)
    .map((event, index) => event.item ? codexEntryToImage(event.item, index, outputFormat) : null)
    .filter((image): image is GeneratedOpenAIImage => image !== null);

  const completedOutputImages = (completedResponse?.response?.output ?? [])
    .filter((entry) => entry.type === "image_generation_call")
    .map((entry, index) => codexEntryToImage(entry, index, outputFormat))
    .filter((image): image is GeneratedOpenAIImage => image !== null);

  return outputItemImages.length > 0 ? outputItemImages : completedOutputImages;
}

async function fetchImageUrl(params: {
  url: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  fallbackMimeType: string;
}): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const response = await params.fetchImpl(params.url, {signal: params.signal});
  await assertOk(response, "OpenAI image URL fetch failed");
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: trimToNull(response.headers.get("content-type")) ?? params.fallbackMimeType,
  };
}

async function parseOpenAIImageApiResponse(params: {
  payload: OpenAIImageApiResponse;
  outputFormat: OpenAIImageOutputFormat;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<readonly GeneratedOpenAIImage[]> {
  const output = resolveOpenAIImageMime(params.outputFormat);
  const images: GeneratedOpenAIImage[] = [];

  for (const [index, entry] of (params.payload.data ?? []).entries()) {
    if (entry.b64_json) {
      images.push({
        buffer: Buffer.from(entry.b64_json, "base64"),
        mimeType: output.mimeType,
        fileName: `image-${index + 1}.${output.extension}`,
        ...(entry.revised_prompt ? {revisedPrompt: entry.revised_prompt} : {}),
      });
      continue;
    }

    if (entry.url) {
      const fetched = await fetchImageUrl({
        url: entry.url,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
        fallbackMimeType: output.mimeType,
      });
      images.push({
        buffer: fetched.buffer,
        mimeType: fetched.mimeType,
        fileName: `image-${index + 1}.${output.extension}`,
        ...(entry.revised_prompt ? {revisedPrompt: entry.revised_prompt} : {}),
      });
    }
  }

  return images;
}

export class OpenAIImageClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAIImageClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generate(request: GenerateOpenAIImageRequest): Promise<GenerateOpenAIImageResult> {
    const auth = resolveOpenAIImageAuth(this.env);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    try {
      if (auth.kind === "codex-oauth") {
        return await this.generateViaCodex(request, auth.token, signal);
      }

      return await this.generateViaImagesApi(request, auth.token, signal);
    } catch (error) {
      if (request.signal?.aborted) {
        throw new Error("image_generate was aborted.");
      }
      if (timeoutSignal.aborted) {
        throw new Error(`image_generate timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    }
  }

  private async generateViaCodex(
    request: GenerateOpenAIImageRequest,
    token: string,
    signal: AbortSignal,
  ): Promise<GenerateOpenAIImageResult> {
    const responsesModel = trimToNull(this.env.PANDA_IMAGE_CODEX_RESPONSES_MODEL) ?? DEFAULT_CODEX_RESPONSES_MODEL;
    const inputImages = request.images ?? [];
    const content: Array<Record<string, unknown>> = [
      {type: "input_text", text: request.prompt},
      ...inputImages.map((image) => ({
        type: "input_image",
        image_url: toDataUrl(image),
        detail: "auto",
      })),
    ];

    const images: GeneratedOpenAIImage[] = [];
    for (let index = 0; index < request.count; index += 1) {
      const response = await this.fetchImpl(`${OPENAI_CODEX_IMAGE_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: responsesModel,
          input: [{
            role: "user",
            content,
          }],
          instructions: "You are an image generation assistant.",
          tools: [{
            type: "image_generation",
            model: request.model,
            size: request.size,
            quality: request.quality,
            output_format: request.outputFormat,
            background: request.background,
            moderation: request.moderation,
            ...(request.outputCompression !== undefined ? {output_compression: request.outputCompression} : {}),
          }],
          tool_choice: {type: "image_generation"},
          stream: true,
          store: false,
        }),
        signal,
      });

      await assertOk(response, "OpenAI Codex image generation failed");
      images.push(...parseCodexImageGenerationResult(await readResponseBodyText(response), request.outputFormat));
    }

    return {
      provider: "openai",
      authKind: "codex-oauth",
      model: request.model,
      responsesModel,
      images,
    };
  }

  private async generateViaImagesApi(
    request: GenerateOpenAIImageRequest,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<GenerateOpenAIImageResult> {
    const isEdit = (request.images?.length ?? 0) > 0;
    const url = `${OPENAI_IMAGE_BASE_URL}/images/${isEdit ? "edits" : "generations"}`;
    let response: Response;

    if (isEdit) {
      const body = new FormData();
      body.set("model", request.model);
      body.set("prompt", request.prompt);
      body.set("n", String(request.count));
      body.set("size", request.size);
      appendImageOptions(body, request);

      for (const image of request.images ?? []) {
        body.append("image[]", new Blob([toUploadBytes(image.buffer)], {type: image.mimeType}), image.fileName);
      }

      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal,
      });
    } else {
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt,
        n: request.count,
        size: request.size,
      };
      appendImageOptions(body, request);

      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    }

    await assertOk(response, isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed");
    const payload = (await response.json()) as OpenAIImageApiResponse;
    const images = await parseOpenAIImageApiResponse({
      payload,
      outputFormat: request.outputFormat,
      fetchImpl: this.fetchImpl,
      signal,
    });

    return {
      provider: "openai",
      authKind: "openai-api-key",
      model: request.model,
      images,
    };
  }
}
