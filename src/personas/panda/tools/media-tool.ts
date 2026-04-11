import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {access, mkdtemp, readdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {z} from "zod";

import {Tool} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {JsonObject, ToolResultPayload} from "../../../kernel/agent/types.js";
import type {PandaSessionContext} from "../types.js";
import {resolvePandaPath} from "./context.js";

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

  const details: JsonObject = {
    kind: "image",
    path: filePath,
    originalPath,
    mimeType,
    bytes: bytes.length,
    ...(metadata.width !== undefined ? { width: metadata.width } : {}),
    ...(metadata.height !== undefined ? { height: metadata.height } : {}),
  };

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
): Promise<ToolResultPayload> {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), `panda-pdf-preview-${randomUUID()}-`));

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

    const previewBytes = await readFile(previewPath);
    const metadata = await readImageMetadata(previewPath);

    const details: JsonObject = {
      kind: "pdf",
      path: filePath,
      originalPath,
      previewPath,
      previewMimeType: "image/png",
      previewBytes: previewBytes.length,
      ...(metadata.width !== undefined ? { previewWidth: metadata.width } : {}),
      ...(metadata.height !== undefined ? { previewHeight: metadata.height } : {}),
    };

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
          data: previewBytes.toString("base64"),
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

export class MediaTool<TContext = PandaSessionContext> extends Tool<typeof MediaTool.schema, TContext> {
  static schema = z.object({
    path: z.string().trim().min(1).describe("Absolute path or path relative to the current working directory."),
  });

  name = "view_media";
  description =
    "Read a local image or PDF file. Images are attached directly. PDFs are attached as preview images generated from the file.";
  schema = MediaTool.schema;

  private readonly pdfPreviewSize: number;

  constructor(options: MediaToolOptions = {}) {
    super();
    this.pdfPreviewSize = options.pdfPreviewSize ?? DEFAULT_PDF_PREVIEW_SIZE;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.path === "string" ? args.path : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof MediaTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const resolvedPath = resolvePandaPath(args.path, run.context);
    await ensureReadableFile(resolvedPath);

    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeType = IMAGE_EXTENSIONS.get(extension);
    if (mimeType) {
      return imagePayload(resolvedPath, args.path, mimeType);
    }

    if (extension === ".pdf") {
      return pdfPayload(resolvedPath, args.path, this.pdfPreviewSize);
    }

    throw new ToolError(
      `Unsupported file type for ${resolvedPath}. Supported types are images (${[...IMAGE_EXTENSIONS.keys()].join(", ")}) and .pdf.`,
    );
  }
}
