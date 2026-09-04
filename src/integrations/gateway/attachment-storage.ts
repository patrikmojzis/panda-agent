import {randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import type {PostgresGatewayStore} from "../../domain/gateway/postgres.js";
import {resolveAgentMediaDir, resolveDataDir} from "../../lib/data-dir.js";
import {readSafePathSegment} from "../../lib/path-segments.js";
import {DrainLoop} from "../../lib/drain-loop.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANIFEST = "upload.json";
const PAYLOAD = "payload";

interface UploadDirectory {
  id: string;
  sourceId: string;
  agentKey: string;
  connectorKey: string;
  expiresAt: number;
  directory: string;
  localPath: string;
}

type CleanupStore = Pick<PostgresGatewayStore, "discardAttachmentUpload" | "removeAttachmentUploadReservation">;

export async function createGatewayUploadDirectory(input: {
  sourceId: string;
  agentKey: string;
  connectorKey: string;
  expiresAt: number;
  env?: NodeJS.ProcessEnv;
}): Promise<UploadDirectory> {
  const id = randomUUID();
  const parent = path.join(resolveAgentMediaDir(input.agentKey, input.env), "gateway", input.connectorKey, ".uploads");
  await fs.mkdir(parent, {recursive: true, mode: 0o700});
  const directory = path.join(parent, id);
  await fs.mkdir(directory, {mode: 0o700});
  const upload = {id, directory, localPath: path.join(directory, PAYLOAD), sourceId: input.sourceId,
    agentKey: input.agentKey, connectorKey: input.connectorKey, expiresAt: input.expiresAt};
  // The marker precedes admission. A crash before the DB insert leaves a discoverable orphan.
  try {
    await fs.writeFile(path.join(directory, MANIFEST), JSON.stringify({version: 1, id, sourceId: input.sourceId,
      agentKey: input.agentKey, connectorKey: input.connectorKey, expiresAt: input.expiresAt}), {flag: "wx", mode: 0o600});
  } catch (error) {
    await unlinkIfPresent(path.join(directory, MANIFEST)).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
  return upload;
}

async function unlinkIfPresent(filename: string): Promise<void> {
  await fs.unlink(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function cleanGatewayUploadDirectory(input: {
  upload: UploadDirectory;
  store: CleanupStore;
  expiredOnly?: boolean;
}): Promise<void> {
  const {upload, store} = input;
  const proof = await store.discardAttachmentUpload({...upload, expiredOnly: input.expiredOnly});
  if (proof === "active" || proof === "mismatch") return;
  if (proof === "retained") {
    // Metadata, including expired bound/delivered rows, owns retention from this point.
    await unlinkIfPresent(path.join(upload.directory, MANIFEST));
    await store.removeAttachmentUploadReservation(upload.id);
    return;
  }
  const discarded = `${upload.directory}.discarding`;
  await fs.rename(upload.directory, discarded).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  // Never recursively traverse media. Each owned directory has only these two files.
  await unlinkIfPresent(path.join(discarded, PAYLOAD));
  await unlinkIfPresent(path.join(discarded, MANIFEST));
  await fs.rmdir(discarded).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await store.removeAttachmentUploadReservation(upload.id);
}

async function* directories(parent: string): AsyncGenerator<string> {
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try { directory = await fs.opendir(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of directory) {
    // Empty yields also count toward a pass budget; unrelated entries cannot make a hot scan.
    yield entry.isDirectory() ? entry.name : "";
  }
}

async function* uploadDirectories(env?: NodeJS.ProcessEnv): AsyncGenerator<UploadDirectory | null> {
  for await (const agentKey of directories(path.join(resolveDataDir(env), "agents"))) {
    yield null;
    if (!readSafePathSegment(agentKey)) continue;
    const mediaRoot = path.join(resolveAgentMediaDir(agentKey, env), "gateway");
    for await (const connectorKey of directories(mediaRoot)) {
      yield null;
      if (!connectorKey) continue;
      for await (const entry of directories(path.join(mediaRoot, connectorKey, ".uploads"))) {
        const id = entry.replace(/\.discarding$/, "");
        if (!UUID.test(id)) { yield null; continue; }
        const directory = path.join(mediaRoot, connectorKey, ".uploads", id);
        const actualDirectory = path.join(mediaRoot, connectorKey, ".uploads", entry);
        let marker: Record<string, unknown>;
        try {
          const stat = await fs.lstat(path.join(actualDirectory, MANIFEST));
          if (!stat.isFile() || stat.size > 2048) { yield null; continue; }
          marker = JSON.parse(await fs.readFile(path.join(actualDirectory, MANIFEST), "utf8")) as Record<string, unknown>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && entry.endsWith(".discarding")) {
            // A crash after removing the marker can leave an empty directory. rmdir cannot delete files.
            await fs.rmdir(actualDirectory).catch((cleanupError: NodeJS.ErrnoException) => {
              if (cleanupError.code !== "ENOENT" && cleanupError.code !== "ENOTEMPTY") throw cleanupError;
            });
          }
          yield null; continue;
        }
        if (!marker || typeof marker !== "object" || marker.version !== 1 || marker.id !== id || marker.agentKey !== agentKey || marker.connectorKey !== connectorKey
          || typeof marker.sourceId !== "string" || (connectorKey !== marker.sourceId && !connectorKey.startsWith(`${marker.sourceId}__`))
          || typeof marker.expiresAt !== "number" || !Number.isFinite(marker.expiresAt)) { yield null; continue; }
        yield {id, sourceId: marker.sourceId, agentKey, connectorKey, expiresAt: marker.expiresAt, directory, localPath: path.join(directory, PAYLOAD)};
      }
    }
  }
}

/** Reconciles only explicit upload markers; existing media files never become cleanup candidates. */
export function createGatewayUploadJanitor(input: {store: CleanupStore & Pick<PostgresGatewayStore, "removeExpiredAttachmentUploadReservations">; env?: NodeJS.ProcessEnv}) {
  let scan: AsyncGenerator<UploadDirectory | null> | undefined;
  const loop = new DrainLoop({label: "gateway upload cleanup", pollIntervalMs: 5_000, drain: async () => {
    await input.store.removeExpiredAttachmentUploadReservations(64);
    scan ??= uploadDirectories(input.env);
    for (let count = 0; count < 64; count += 1) {
      const next = await scan.next();
      if (next.done) { scan = undefined; return; }
      if (next.value && next.value.expiresAt <= Date.now()) {
        await cleanGatewayUploadDirectory({upload: next.value, store: input.store, expiredOnly: true});
      }
    }
  }});
  return {
    start: () => loop.start(),
    async stop(): Promise<void> { await loop.stop(); await scan?.return(undefined); scan = undefined; },
  };
}
