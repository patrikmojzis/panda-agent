import {createHash} from "node:crypto";

import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {CommandFileResolver} from "../../domain/commands/files.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../../domain/commands/types.js";
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
import {withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {JsonObject} from "../../lib/json.js";
import {trimToNull} from "../../lib/strings.js";
import {
    loadReferenceImages,
    persistedImageDetails,
    persistGeneratedImages,
    renderGeneratedImagesText,
    toImageArtifact,
} from "./image-generation-media.js";
import {buildBackgroundJobPayload} from "../tools/background-job-tools.js";
import {serializeToolResultForBackgroundJob} from "../tools/shared.js";

export interface ImageGenerateClient {
  generate(request: GenerateOpenAIImageRequest): Promise<GenerateOpenAIImageResult>;
}

export interface ImageGenerateCommandOptions {
  env?: NodeJS.ProcessEnv;
  client?: ImageGenerateClient;
  fetchImpl?: typeof fetch;
  jobService?: BackgroundToolJobService;
}

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const IMAGE_GENERATE_COMMAND_NAME = "image.generate";
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

export const imageGenerateInputSchema = z.object({
  prompt: z.string().trim().min(1).max(PROMPT_HARD_CAP_CHARS).describe("The current image request."),
  images: z.array(z.string().trim().min(1))
    .max(MAX_REFERENCE_IMAGES)
    .optional()
    .describe("Local reference image paths or Panda artifact paths. Supports png, jpg, jpeg, and webp."),
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

type ImageGenerateInput = z.output<typeof imageGenerateInputSchema>;

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

export const imageGenerateCommandDescriptor: CommandDescriptor = {
  name: IMAGE_GENERATE_COMMAND_NAME,
  summary: "Start an OpenAI image generation background job.",
  description: "Starts a gpt-image image generation job and returns a background job id. Reference image paths are resolved by Panda core before generation.",
  usage: "panda image generate --prompt <text|@file|@-> [--image <path>...] [--model <model>] [--size <size>] [--quality low|medium|high|auto] [--format png|jpeg|webp] [--compression <0-100>] [--background transparent|opaque|auto] [--moderation low|auto] [--count <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "prompt",
      description: "Image request prompt. Use @file or @- for longer prompts.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "image",
      description: "Repeatable local reference image path. Supports png, jpg, jpeg, and webp.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "size",
      description: "Output size, for example auto, 1024x1024, 1536x1024, or 1024x1536.",
      valueType: "string",
      valueName: "size",
    },
    {
      name: "quality",
      description: "Image quality.",
      valueType: "string",
      valueName: "low|medium|high|auto",
      enumValues: ["low", "medium", "high", "auto"],
    },
    {
      name: "format",
      description: "Output image format.",
      valueType: "string",
      valueName: "png|jpeg|webp",
      enumValues: ["png", "jpeg", "webp"],
    },
    {
      name: "compression",
      description: "Compression for jpeg or webp output, 0-100.",
      valueType: "number",
      valueName: "0-100",
    },
    {
      name: "background",
      description: "Output background behavior.",
      valueType: "string",
      valueName: "transparent|opaque|auto",
      enumValues: ["transparent", "opaque", "auto"],
    },
    {
      name: "moderation",
      description: "Moderation strictness.",
      valueType: "string",
      valueName: "low|auto",
      enumValues: ["low", "auto"],
    },
    {
      name: "count",
      description: "Number of images to generate, 1-4.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "model",
      description: "Image model. Defaults to gpt-image-2.",
      valueType: "string",
      valueName: "model",
    },
    {
      name: "json",
      description: "JSON object containing prompt plus optional images, model, size, quality, outputFormat, outputCompression, background, moderation, and count.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Generate one image",
      command: "panda image generate --prompt 'A clean product photo of a red mug'",
    },
    {
      description: "Use a reference image from the current workspace",
      command: "panda image generate --prompt 'Restyle this as a pencil sketch' --image ./reference.png",
    },
    {
      description: "Use JSON input",
      command: "panda image generate --json '{\"prompt\":\"A clean product photo of a red mug\"}'",
    },
  ],
  requiredCapabilities: [IMAGE_GENERATE_COMMAND_NAME],
  resultShape: {
    jobId: "string",
    kind: "image_generate",
    status: "running|completed|failed|cancelled",
    summary: "string",
    progress: "object|null",
  },
};

async function resolveCommandReferenceImages(
  args: ImageGenerateInput,
  request: CommandRequest,
  fileResolver: CommandFileResolver | undefined,
): Promise<ImageGenerateInput> {
  if (!fileResolver || !args.images || args.images.length === 0) {
    return args;
  }

  const images = await Promise.all(args.images.map(async (imagePath) => {
    const resolved = await fileResolver.resolveReadablePath({
      request,
      file: {
        path: imagePath,
      },
    });
    return resolved.path;
  }));

  return {
    ...args,
    images,
  };
}

async function runImageGeneration(params: {
  args: ImageGenerateInput;
  context: unknown;
  emitProgress(progress: JsonObject): void;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  client: ImageGenerateClient;
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
      prompt: params.args.prompt,
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
    promptHash: promptHash(params.args.prompt),
    promptChars: params.args.prompt.length,
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

export function createImageGenerateCommand(options: {
  jobService: BackgroundToolJobService;
  env?: NodeJS.ProcessEnv;
  client?: ImageGenerateClient;
  fetchImpl?: typeof fetch;
}, fileResolver?: CommandFileResolver): RegisteredCommand {
  const env = options.env ?? process.env;
  const client = options.client ?? new OpenAIImageClient({
    env,
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
  });

  return {
    descriptor: imageGenerateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      if (!request.scope.threadId) {
        throw new Error("image.generate requires resolved command thread scope.");
      }

      const parsed = imageGenerateInputSchema.parse(request.input);
      const args = await resolveCommandReferenceImages(parsed, request, fileResolver);
      validateImageOptions({
        background: args.background ?? defaultImageGenerateArgs().background,
        outputFormat: args.outputFormat ?? defaultImageGenerateArgs().outputFormat,
        outputCompression: args.outputCompression,
      });

      const context: Partial<DefaultAgentSessionContext> = {
        agentKey: request.scope.agentKey,
        threadId: request.scope.threadId,
        ...(request.workingDirectory ? {cwd: request.workingDirectory} : {}),
      };
      const record = await options.jobService.start({
        threadId: request.scope.threadId,
        kind: "image_generate",
        summary: args.prompt,
        start: ({signal, emitProgress}) => ({
          progress: {
            status: "queued",
          },
          done: runImageGeneration({
            args,
            context,
            emitProgress,
            signal,
            env,
            client,
          }).then((payload) => ({
            status: "completed" as const,
            result: serializeToolResultForBackgroundJob(payload),
          })),
        }),
      });

      return {
        ok: true,
        command: IMAGE_GENERATE_COMMAND_NAME,
        output: buildBackgroundJobPayload(record),
        summary: `Started image generation job ${record.id}.`,
      };
    },
  };
}
