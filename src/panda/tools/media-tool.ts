import {execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {access, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import {resolveAgentMediaDir, resolveMediaDir} from "../../app/runtime/data-dir.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {stripToolArtifactInlineImages, withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import type {JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveContextPath} from "../../app/runtime/panda-path-context.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PDF_PREVIEW_SIZE = 1600;
const IMAGE_EXTENSIONS = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

export interface MediaToolOptions {
  pdfPreviewSize?: number;
}

function trimNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function resolveMediaArtifactRoot(context: DefaultAgentSessionContext | undefined, env: NodeJS.ProcessEnv): string {
  const agentKey = trimNonEmptyString(context?.agentKey);
  if (agentKey) {
    return resolveAgentMediaDir(agentKey, env);
  }

  return resolveMediaDir(env);
}

async function writeDurablePdfPreview(
  previewPath: string,
  sourcePath: string,
  previewSize: number,
  context: DefaultAgentSessionContext | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{path: string; bytes: Buffer}> {
  const root = resolveMediaArtifactRoot(context, env);
  const artifactDir = path.join(root, "view_media", "previews");
  await mkdir(artifactDir, {recursive: true});

  const cacheKey = createHash("sha256")
    .update(sourcePath)
    .update("\0")
    .update(String(previewSize))
    .digest("hex");
  const destination = path.join(artifactDir, `${cacheKey}.png`);
  const bytes = await readFile(previewPath);
  await writeFile(destination, bytes);

  return {
    path: destination,
    bytes,
  };
}

async function ensureReadableFile(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new ToolError(`No readable file found at ${filePath}`);
  }
}

async function readImageMetadata(filePath: string): Promise<{ width?: number; height?: number }> {
  try {
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], {
      encoding: "utf8",
    });

    const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1];
    const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1];

    return {
      width: width ? Number.parseInt(width, 10) : undefined,
      height: height ? Number.parseInt(height, 10) : undefined,
    };
  } catch {
    return {};
  }
}

async function imagePayload(filePath: string, originalPath: string, mimeType: string): Promise<ToolResultPayload> {
  const bytes = await readFile(filePath);
  const metadata = await readImageMetadata(filePath);

  const details = withArtifactDetails({
    kind: "image",
    path: filePath,
    originalPath,
    mimeType,
    bytes: bytes.length,
    ...(metadata.width !== undefined ? { width: metadata.width } : {}),
    ...(metadata.height !== undefined ? { height: metadata.height } : {}),
  }, {
    kind: "image",
    source: "view_media",
    path: filePath,
    mimeType,
    bytes: bytes.length,
    ...(metadata.width !== undefined ? {width: metadata.width} : {}),
    ...(metadata.height !== undefined ? {height: metadata.height} : {}),
    originalPath,
  });

  return {
    content: [
      {
        type: "text",
        text: [
          `Image file: ${path.basename(filePath)}`,
          `Resolved path: ${filePath}`,
          ...(metadata.width !== undefined && metadata.height !== undefined
            ? [`Dimensions: ${metadata.width} x ${metadata.height}`]
            : []),
        ].join("\n"),
      },
      {
        type: "image",
        data: bytes.toString("base64"),
        mimeType,
      },
    ],
    details,
  };
}

async function pdfPayload(
  filePath: string,
  originalPath: string,
  previewSize: number,
  context: DefaultAgentSessionContext | undefined,
  env: NodeJS.ProcessEnv,
): Promise<ToolResultPayload> {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), `runtime-pdf-preview-${randomUUID()}-`));

  try {
    await execFileAsync("qlmanage", ["-t", "-s", String(previewSize), "-o", tempDirectory, filePath], {
      encoding: "utf8",
    });

    const generatedFiles = (await readdir(tempDirectory))
      .filter((entry) => entry.toLowerCase().endsWith(".png"))
      .map((entry) => path.join(tempDirectory, entry));

    const previewPath = generatedFiles[0];
    if (!previewPath) {
      throw new ToolError(`Unable to render a preview for ${filePath}`);
    }

    const durablePreview = await writeDurablePdfPreview(previewPath, filePath, previewSize, context, env);
    const metadata = await readImageMetadata(durablePreview.path);

    const details = withArtifactDetails({
      kind: "pdf",
      path: filePath,
      originalPath,
      previewPath: durablePreview.path,
      previewMimeType: "image/png",
      previewBytes: durablePreview.bytes.length,
      ...(metadata.width !== undefined ? { previewWidth: metadata.width } : {}),
      ...(metadata.height !== undefined ? { previewHeight: metadata.height } : {}),
    }, {
      kind: "pdf",
      source: "view_media",
      path: filePath,
      mimeType: "application/pdf",
      originalPath,
      preview: {
        kind: "image",
        path: durablePreview.path,
        mimeType: "image/png",
        bytes: durablePreview.bytes.length,
        ...(metadata.width !== undefined ? {width: metadata.width} : {}),
        ...(metadata.height !== undefined ? {height: metadata.height} : {}),
      },
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `PDF file: ${path.basename(filePath)}`,
            `Resolved path: ${filePath}`,
            "Attached preview image is generated from the PDF in this environment.",
          ].join("\n"),
        },
        {
          type: "image",
          data: durablePreview.bytes.toString("base64"),
          mimeType: "image/png",
        },
      ],
      details,
    };
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Unable to render PDF preview for ${filePath}: ${message}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export class MediaTool<TContext = DefaultAgentSessionContext> extends Tool<typeof MediaTool.schema, TContext> {
  static schema = z.object({
    path: z.string().trim().min(1).describe(
      "Absolute path or path relative to the current working directory. In remote bash mode, agent-home runner paths are translated automatically.",
    ),
  });

  name = "view_media";
  description =
    "Read an image or PDF file. Images are attached directly. PDFs are attached as preview images generated from the file.";
  schema = MediaTool.schema;

  private readonly pdfPreviewSize: number;

  constructor(options: MediaToolOptions = {}) {
    super();
    this.pdfPreviewSize = options.pdfPreviewSize ?? DEFAULT_PDF_PREVIEW_SIZE;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.path === "string" ? args.path : super.formatCall(args);
  }

  override redactResultMessage(message: ToolResultMessage<JsonValue>): ToolResultMessage<JsonValue> {
    if (message.toolName !== this.name) {
      return message;
    }

    return stripToolArtifactInlineImages(message);
  }

  async handle(
    args: z.output<typeof MediaTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const resolvedPath = resolveContextPath(args.path, run.context);
    await ensureReadableFile(resolvedPath);

    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeType = IMAGE_EXTENSIONS.get(extension);
    if (mimeType) {
      return imagePayload(resolvedPath, args.path, mimeType);
    }

    if (extension === ".pdf") {
      return pdfPayload(
        resolvedPath,
        args.path,
        this.pdfPreviewSize,
        run.context as DefaultAgentSessionContext | undefined,
        process.env,
      );
    }

    throw new ToolError(
      `Unsupported file type for ${resolvedPath}. Supported types are images (${[...IMAGE_EXTENSIONS.keys()].join(", ")}) and .pdf.`,
    );
  }
}
