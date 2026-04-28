import {createHash} from "node:crypto";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import {
    type GenerateOpenAIImageRequest,
    type GenerateOpenAIImageResult,
    type OpenAIImageBackground,
    OpenAIImageClient,
    type OpenAIImageModeration,
    type OpenAIImageOutputFormat,
    type OpenAIImageQuality,
} from "../../integrations/providers/openai-image/client.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {stripToolArtifactInlineImages, withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import {Tool, type ToolOutput} from "../../kernel/agent/tool.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {LlmRuntime} from "../../kernel/agent/runtime.js";
import {readThreadId} from "../../integrations/shell/runtime-context.js";
import {trimToNull} from "../../lib/strings.js";
import {
    composeImagePrompt,
    DEFAULT_IMAGE_BRIEF_MAX_CHARS,
    DEFAULT_IMAGE_CONTEXT_MESSAGES,
    DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS,
    type ImagePromptComposition,
    resolveImageContextEnabled,
} from "./image-generation/brief.js";
import {
    loadReferenceImages,
    persistedImageDetails,
    persistGeneratedImages,
    renderGeneratedImagesText,
    toImageArtifact,
} from "./image-generation/media.js";
import {buildBackgroundJobPayload} from "./background-job-tools.js";

export interface ImageGenerateClient {
  generate(request: GenerateOpenAIImageRequest): Promise<GenerateOpenAIImageResult>;
}

export interface ImageGenerateToolOptions {
  env?: NodeJS.ProcessEnv;
  client?: ImageGenerateClient;
  fetchImpl?: typeof fetch;
  runtime?: Pick<LlmRuntime, "complete">;
  jobService?: BackgroundToolJobService;
}

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const PROMPT_HARD_CAP_CHARS = 32_000;
const MAX_REFERENCE_IMAGES = 5;
const MAX_IMAGE_RESULTS = 4;

const outputFormatSchema = z.enum(["png", "jpeg", "webp"]);
const backgroundSchema = z.enum(["transparent", "opaque", "auto"]);
const qualitySchema = z.enum(["low", "medium", "high", "auto"]);
const moderationSchema = z.enum(["low", "auto"]);
const sizeSchema = z.string().trim().min(1).refine((value) => {
  if (value === "auto") {
    return true;
  }

  const match = /^(\d{1,4})x(\d{1,4})$/.exec(value);
  if (!match) {
    return false;
  }

  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  return width > 0 && height > 0 && width <= 3840 && height <= 3840;
}, "size must be auto or WIDTHxHEIGHT with both edges up to 3840px");

function defaultImageGenerateArgs() {
  return {
    model: DEFAULT_IMAGE_MODEL,
    size: "auto",
    quality: "auto" as OpenAIImageQuality,
    outputFormat: "png" as OpenAIImageOutputFormat,
    background: "auto" as OpenAIImageBackground,
    moderation: "auto" as OpenAIImageModeration,
    count: 1,
  };
}

function promptHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateImageOptions(args: {
  background: OpenAIImageBackground;
  outputFormat: OpenAIImageOutputFormat;
  outputCompression?: number;
}): void {
  if (args.background === "transparent" && args.outputFormat === "jpeg") {
    throw new ToolError("background=transparent requires outputFormat png or webp.");
  }

  if (args.outputCompression !== undefined && args.outputFormat === "png") {
    throw new ToolError("outputCompression requires outputFormat jpeg or webp.");
  }
}

async function composePromptWithFallback(params: {
  prompt: string;
  contextEnabled: boolean;
  messages: RunContext<unknown>["messages"];
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  runtime?: Pick<LlmRuntime, "complete">;
}): Promise<ImagePromptComposition> {
  try {
    return await composeImagePrompt({
      prompt: params.prompt,
      messages: params.messages,
      contextEnabled: params.contextEnabled,
      env: params.env,
      runtime: params.runtime,
      signal: params.signal,
      maxMessages: DEFAULT_IMAGE_CONTEXT_MESSAGES,
      maxBriefChars: DEFAULT_IMAGE_BRIEF_MAX_CHARS,
      maxFinalPromptChars: DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS,
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw new ToolError("image_generate was aborted while composing image context.");
    }

    const compiledPrompt = params.prompt.slice(0, DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS);
    return {
      compiledPrompt,
      contextEnabled: params.contextEnabled,
      contextUsed: false,
      contextMessages: 0,
      briefChars: 0,
      promptChars: params.prompt.length,
      compiledPromptChars: compiledPrompt.length,
      contextError: readErrorMessage(error),
    };
  }
}

function buildSettingsDetails(params: {
  model: string;
  size: string;
  quality: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
  background: OpenAIImageBackground;
  moderation: OpenAIImageModeration;
  count: number;
  outputCompression?: number;
}): JsonObject {
  return {
    model: params.model,
    size: params.size,
    quality: params.quality,
    outputFormat: params.outputFormat,
    background: params.background,
    moderation: params.moderation,
    count: params.count,
    ...(params.outputCompression !== undefined ? {outputCompression: params.outputCompression} : {}),
  };
}

async function runImageGeneration(params: {
  args: z.output<typeof ImageGenerateTool.schema>;
  context: unknown;
  messages: RunContext<unknown>["messages"];
  emitProgress(progress: JsonObject): void;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  client: ImageGenerateClient;
  runtime?: Pick<LlmRuntime, "complete">;
}): Promise<ToolResultPayload> {
  const defaults = defaultImageGenerateArgs();
  const model = trimToNull(params.args.model) ?? defaults.model;
  const size = params.args.size ?? defaults.size;
  const quality = params.args.quality ?? defaults.quality;
  const outputFormat = params.args.outputFormat ?? defaults.outputFormat;
  const background = params.args.background ?? defaults.background;
  const moderation = params.args.moderation ?? defaults.moderation;
  const count = params.args.count ?? defaults.count;
  const outputCompression = params.args.outputCompression;
  validateImageOptions({background, outputFormat, outputCompression});

  const contextEnabled = resolveImageContextEnabled({
    requested: params.args.context,
    env: params.env,
  });

  const referencePaths = params.args.images ?? [];
  params.emitProgress({
    status: "loading_reference_images",
    count: referencePaths.length,
  });
  const inputImages = await loadReferenceImages({
    paths: referencePaths,
    context: params.context,
    env: params.env,
  });

  params.emitProgress({
    status: "composing_image_prompt",
    context: contextEnabled,
  });
  const promptComposition = await composePromptWithFallback({
    prompt: params.args.prompt,
    contextEnabled,
    messages: params.messages,
    signal: params.signal,
    env: params.env,
    runtime: params.runtime,
  });

  params.emitProgress({
    status: "generating_image",
    model,
    size,
    quality,
    outputFormat,
    count,
    inputImages: inputImages.length,
  });

  let generated: GenerateOpenAIImageResult;
  try {
    generated = await params.client.generate({
      prompt: promptComposition.compiledPrompt,
      images: inputImages,
      model,
      size,
      quality,
      outputFormat,
      background,
      moderation,
      count,
      ...(outputCompression !== undefined ? {outputCompression} : {}),
      signal: params.signal,
    });
  } catch (error) {
    throw new ToolError(`OpenAI image generation failed: ${readErrorMessage(error)}`);
  }

  if (generated.images.length === 0) {
    throw new ToolError("OpenAI image generation returned no images.");
  }

  params.emitProgress({
    status: "saving_image",
    count: generated.images.length,
  });
  const persisted = await persistGeneratedImages({
    images: generated.images,
    context: (params.context ?? {}) as Partial<DefaultAgentSessionContext>,
    env: params.env,
    outputFormat,
  });
  const firstImage = persisted[0]!;

  const settings = buildSettingsDetails({
    model,
    size,
    quality,
    outputFormat,
    background,
    moderation,
    count,
    ...(outputCompression !== undefined ? {outputCompression} : {}),
  });
  const baseDetails: JsonObject = {
    kind: "image_generation",
    provider: generated.provider,
    authKind: generated.authKind,
    model: generated.model,
    ...(generated.responsesModel ? {responsesModel: generated.responsesModel} : {}),
    settings,
    promptHash: promptHash(promptComposition.compiledPrompt),
    promptChars: promptComposition.promptChars,
    compiledPromptChars: promptComposition.compiledPromptChars,
    context: {
      enabled: promptComposition.contextEnabled,
      used: promptComposition.contextUsed,
      messages: promptComposition.contextMessages,
      briefChars: promptComposition.briefChars,
      ...(promptComposition.briefModel ? {model: promptComposition.briefModel} : {}),
      ...(promptComposition.contextError ? {error: promptComposition.contextError} : {}),
    },
    inputImageCount: inputImages.length,
    images: persistedImageDetails(persisted),
  };

  const details = withArtifactDetails(baseDetails, toImageArtifact(firstImage));
  return {
    content: [
      {
        type: "text",
        text: renderGeneratedImagesText(persisted),
      },
    ],
    details,
  };
}

function serializeImageGenerationResult(payload: ToolResultPayload): JsonObject {
  return {
    contentText: payload.content
      .flatMap((part) => part.type === "text" && part.text.trim() ? [part.text.trim()] : [])
      .join("\n\n"),
    ...(payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? {details: payload.details as JsonObject}
      : {}),
  };
}

export class ImageGenerateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof ImageGenerateTool.schema, TContext> {
  static schema = z.object({
    prompt: z.string().trim().min(1).max(PROMPT_HARD_CAP_CHARS).describe("The current image request."),
    images: z.array(z.string().trim().min(1))
      .max(MAX_REFERENCE_IMAGES)
      .optional()
      .describe("Local reference image paths or Panda artifact paths. Supports png, jpg, jpeg, and webp."),
    context: z.boolean().optional()
      .describe("Whether to include a cleaned brief from recent conversation context. Defaults on; omit unless the user explicitly asks to disable context."),
    model: z.string().trim().min(1).optional().describe("Image model. Defaults to gpt-image-2."),
    size: sizeSchema.optional().describe("Output size, for example auto, 1024x1024, 1536x1024, or 1024x1536."),
    quality: qualitySchema.optional().describe("Image quality."),
    outputFormat: outputFormatSchema.optional().describe("Output image format."),
    outputCompression: z.number().int().min(0).max(100).optional()
      .describe("Compression for jpeg or webp output."),
    background: backgroundSchema.optional().describe("Output background behavior."),
    moderation: moderationSchema.optional().describe("Moderation strictness."),
    count: z.number().int().min(1).max(MAX_IMAGE_RESULTS).optional().describe("Number of images to generate."),
  });

  name = "image_generate";
  description =
    "Start a background OpenAI gpt-image-2 image generation job and return its job id. Uses recent conversation context by default and accepts local reference image paths. Leave context enabled unless the user explicitly asks otherwise. When iterating on a previous image, pass that image path in images.";
  schema = ImageGenerateTool.schema;

  private readonly env: NodeJS.ProcessEnv;
  private readonly client: ImageGenerateClient;
  private readonly runtime?: Pick<LlmRuntime, "complete">;
  private readonly jobService?: BackgroundToolJobService;

  constructor(options: ImageGenerateToolOptions = {}) {
    super();
    this.env = options.env ?? process.env;
    this.client = options.client ?? new OpenAIImageClient({
      env: this.env,
      ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    });
    this.runtime = options.runtime;
    this.jobService = options.jobService;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.prompt === "string" ? args.prompt : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return super.formatResult(message);
    }

    const imageCount = Array.isArray(details.images) ? details.images.length : 0;
    const model = typeof details.model === "string" ? details.model : DEFAULT_IMAGE_MODEL;
    return imageCount > 0
      ? `Generated ${imageCount} image${imageCount === 1 ? "" : "s"} with ${model}`
      : super.formatResult(message);
  }

  override redactResultMessage(message: ToolResultMessage<JsonValue>): ToolResultMessage<JsonValue> {
    if (message.toolName !== this.name) {
      return message;
    }

    return stripToolArtifactInlineImages(message);
  }

  async handle(
    args: z.output<typeof ImageGenerateTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolOutput> {
    if (!this.jobService) {
      throw new ToolError("image_generate requires background jobs in this runtime.");
    }

    const defaults = defaultImageGenerateArgs();
    validateImageOptions({
      background: args.background ?? defaults.background,
      outputFormat: args.outputFormat ?? defaults.outputFormat,
      outputCompression: args.outputCompression,
    });

    const context = run.context as DefaultAgentSessionContext | undefined;
    const messages = [...(run as RunContext<unknown>).messages];
    const job = await this.jobService.start({
      threadId: readThreadId(context),
      runId: context?.runId,
      kind: "image_generate",
      summary: args.prompt,
      start: ({signal, emitProgress}) => ({
        progress: {
          status: "queued",
        },
        done: runImageGeneration({
          args,
          context,
          messages,
          emitProgress,
          signal,
          env: this.env,
          client: this.client,
          runtime: this.runtime,
        }).then((payload) => ({
          status: "completed" as const,
          result: serializeImageGenerationResult(payload),
        })),
      }),
    });

    return buildBackgroundJobPayload(job);
  }
}
