import {createHash} from "node:crypto";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
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
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {LlmRuntime} from "../../kernel/agent/runtime.js";
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

export interface ImageGenerateClient {
  generate(request: GenerateOpenAIImageRequest): Promise<GenerateOpenAIImageResult>;
}

export interface ImageGenerateToolOptions {
  env?: NodeJS.ProcessEnv;
  client?: ImageGenerateClient;
  fetchImpl?: typeof fetch;
  runtime?: Pick<LlmRuntime, "complete">;
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
  run: RunContext<unknown>;
  env: NodeJS.ProcessEnv;
  runtime?: Pick<LlmRuntime, "complete">;
}): Promise<ImagePromptComposition> {
  try {
    return await composeImagePrompt({
      prompt: params.prompt,
      messages: params.run.messages,
      contextEnabled: params.contextEnabled,
      env: params.env,
      runtime: params.runtime,
      signal: params.run.signal,
      maxMessages: DEFAULT_IMAGE_CONTEXT_MESSAGES,
      maxBriefChars: DEFAULT_IMAGE_BRIEF_MAX_CHARS,
      maxFinalPromptChars: DEFAULT_IMAGE_FINAL_PROMPT_MAX_CHARS,
    });
  } catch (error) {
    if (params.run.signal?.aborted) {
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
    "Generate images with OpenAI gpt-image-2. Uses recent conversation context by default and accepts local reference image paths. Leave context enabled unless the user explicitly asks otherwise. When iterating on a previous image, pass that image path in images.";
  schema = ImageGenerateTool.schema;

  private readonly env: NodeJS.ProcessEnv;
  private readonly client: ImageGenerateClient;
  private readonly runtime?: Pick<LlmRuntime, "complete">;

  constructor(options: ImageGenerateToolOptions = {}) {
    super();
    this.env = options.env ?? process.env;
    this.client = options.client ?? new OpenAIImageClient({
      env: this.env,
      ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    });
    this.runtime = options.runtime;
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
  ): Promise<ToolResultPayload> {
    const defaults = defaultImageGenerateArgs();
    const model = trimToNull(args.model) ?? defaults.model;
    const size = args.size ?? defaults.size;
    const quality = args.quality ?? defaults.quality;
    const outputFormat = args.outputFormat ?? defaults.outputFormat;
    const background = args.background ?? defaults.background;
    const moderation = args.moderation ?? defaults.moderation;
    const count = args.count ?? defaults.count;
    const outputCompression = args.outputCompression;
    validateImageOptions({background, outputFormat, outputCompression});

    const contextEnabled = resolveImageContextEnabled({
      requested: args.context,
      env: this.env,
    });

    const referencePaths = args.images ?? [];
    run.emitToolProgress({
      status: "loading_reference_images",
      count: referencePaths.length,
    });
    const inputImages = await loadReferenceImages({
      paths: referencePaths,
      context: run.context,
      env: this.env,
    });

    run.emitToolProgress({
      status: "composing_image_prompt",
      context: contextEnabled,
    });
    const promptComposition = await composePromptWithFallback({
      prompt: args.prompt,
      contextEnabled,
      run: run as RunContext<unknown>,
      env: this.env,
      runtime: this.runtime,
    });

    run.emitToolProgress({
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
      generated = await this.client.generate({
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
        signal: run.signal,
      });
    } catch (error) {
      throw new ToolError(`OpenAI image generation failed: ${readErrorMessage(error)}`);
    }

    if (generated.images.length === 0) {
      throw new ToolError("OpenAI image generation returned no images.");
    }

    run.emitToolProgress({
      status: "saving_image",
      count: generated.images.length,
    });
    const persisted = await persistGeneratedImages({
      images: generated.images,
      context: (run.context ?? {}) as Partial<DefaultAgentSessionContext>,
      env: this.env,
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
        ...persisted.map((image, index) => ({
          type: "image" as const,
          data: generated.images[index]?.buffer.toString("base64") ?? "",
          mimeType: image.mimeType,
        })),
      ],
      details,
    };
  }
}
