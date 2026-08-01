import * as fs from "node:fs/promises";
import path from "node:path";

import {FileSystemMediaStore} from "../../../domain/channels/media-store.js";
import {resolveAgentMediaDir} from "../../../lib/data-dir.js";
import {
  fetchSafeHttpResource,
  type FetchSafeHttpResourceOptions,
  type FetchSafeHttpResourceResult,
} from "../../web/web-fetch.js";
import {DISCORD_SOURCE} from "./config.js";

export const DISCORD_GIF_MAX_BYTES = 10 * 1024 * 1024;
export const DISCORD_GIF_TIMEOUT_MS = 20_000;
export const DISCORD_GIF_MAX_REDIRECTS = 3;

export interface ResolvedDiscordGif {
  path: string;
  filename: string;
  sizeBytes: number;
}

export interface DiscordGifService {
  validateLocalFile(filePath: string): Promise<ResolvedDiscordGif>;
  downloadRemoteGif(input: {
    agentKey: string;
    connectorKey: string;
    url: string;
  }): Promise<ResolvedDiscordGif>;
}

type DiscordGifFetcher = (
  url: string,
  options: FetchSafeHttpResourceOptions,
) => Promise<FetchSafeHttpResourceResult>;

function hasGifSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 6) {
    return false;
  }
  const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
  return signature === "GIF87a" || signature === "GIF89a";
}

function assertGifSignature(bytes: Uint8Array): void {
  if (!hasGifSignature(bytes)) {
    throw new Error("Discord GIF source does not contain a valid GIF87a or GIF89a signature.");
  }
}

function assertGifSize(sizeBytes: number): void {
  if (sizeBytes > DISCORD_GIF_MAX_BYTES) {
    throw new Error(`Discord GIF exceeds the ${String(DISCORD_GIF_MAX_BYTES)} byte limit.`);
  }
}

function parseContentType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function assertCompatibleGifContentType(value: string | null): void {
  const contentType = parseContentType(value);
  if (contentType !== "image/gif" && contentType !== "application/octet-stream") {
    throw new Error(`Discord GIF URL returned incompatible content type ${contentType ?? "unknown"}.`);
  }
}

async function readFileHeader(filePath: string, length: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(length);
    const {bytesRead} = await handle.read(bytes, 0, length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Creates the narrow GIF validator/downloader used by discord.gif.send. */
export function createDiscordGifService(options: {
  env?: NodeJS.ProcessEnv;
  fetchResource?: DiscordGifFetcher;
  fetchOptions?: Pick<FetchSafeHttpResourceOptions, "fetchImpl" | "lookupHostname">;
  createMediaStore?: (rootDir: string) => Pick<FileSystemMediaStore, "writeMedia">;
} = {}): DiscordGifService {
  const fetchResource = options.fetchResource ?? fetchSafeHttpResource;
  const createMediaStore = options.createMediaStore ?? ((rootDir) => new FileSystemMediaStore({rootDir}));

  return {
    async validateLocalFile(filePath) {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error("Discord GIF source must be a file.");
      }
      assertGifSize(stat.size);
      assertGifSignature(await readFileHeader(filePath, 6));
      return {
        path: filePath,
        filename: path.basename(filePath),
        sizeBytes: stat.size,
      };
    },

    async downloadRemoteGif(input) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(input.url);
      } catch {
        throw new Error("discord.gif.send url must be a valid HTTPS URL.");
      }
      if (parsedUrl.protocol !== "https:") {
        throw new Error("discord.gif.send url must use HTTPS.");
      }

      const response = await fetchResource(parsedUrl.toString(), {
        ...options.fetchOptions,
        allowedProtocols: ["https:"],
        timeoutMs: DISCORD_GIF_TIMEOUT_MS,
        maxRedirects: DISCORD_GIF_MAX_REDIRECTS,
        maxResponseBytes: DISCORD_GIF_MAX_BYTES,
        readErrorBody: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Discord GIF URL returned HTTP ${String(response.status)}.`);
      }
      assertGifSize(response.downloadedBytes);
      assertCompatibleGifContentType(response.contentType);
      assertGifSignature(response.bodyBytes);

      const descriptor = await createMediaStore(resolveAgentMediaDir(input.agentKey, options.env)).writeMedia({
        bytes: response.bodyBytes,
        source: DISCORD_SOURCE,
        connectorKey: input.connectorKey,
        mimeType: "image/gif",
        sizeBytes: response.downloadedBytes,
        hintFilename: "discord-remote.gif",
        metadata: {kind: "discord_gif"},
      });
      return {
        path: descriptor.localPath,
        filename: descriptor.originalFilename ?? "discord-remote.gif",
        sizeBytes: descriptor.sizeBytes,
      };
    },
  };
}
