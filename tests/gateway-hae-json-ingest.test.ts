import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import type {GatewayServer} from "../src/integrations/gateway/http.js";
import {startGatewayServer} from "../src/integrations/gateway/http.js";
import type {GatewayServerOptions} from "../src/integrations/gateway/http-config.js";
import {
  GATEWAY_HAE_JSON_PATH,
  type GatewayHaeJsonFileSystem,
  writeHaeJsonInboxFile,
} from "../src/integrations/gateway/hae-json-ingest.js";

const FIXED_NOW = new Date("2026-06-16T18:45:00.000Z");
const HAE_TOKEN = "synthetic-hae-token";
const PRIVATE_MARKER = "synthetic-health-private-marker";

async function listDirSafe(target: string): Promise<string[]> {
  try {
    return await fs.readdir(target);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

describe("Gateway HAE JSON ingest", () => {
  const servers: GatewayServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close().catch(() => undefined);
      }
    }
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        await fs.rm(tempDir, {recursive: true, force: true});
      }
    }
  });

  async function createTempInbox(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-gateway-hae-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "inbox");
  }

  async function startHaeServer(inboxDir: string) {
    const genericStoreCalls = {
      getEventType: vi.fn(async () => {
        throw new Error("HAE ingest must not read generic gateway event types.");
      }),
      recordStrikeAndMaybeSuspend: vi.fn(async () => {
        throw new Error("HAE ingest must not write gateway strikes.");
      }),
      resolveAccessToken: vi.fn(async () => {
        throw new Error("HAE ingest must not resolve OAuth gateway tokens.");
      }),
      resolveDeviceToken: vi.fn(async () => {
        throw new Error("HAE ingest must not resolve gateway device tokens.");
      }),
      storeEvent: vi.fn(async () => {
        throw new Error("HAE ingest must not store gateway events.");
      }),
      storeEventWithAttachments: vi.fn(async () => {
        throw new Error("HAE ingest must not store gateway events.");
      }),
      touchDeviceSeen: vi.fn(async () => {
        throw new Error("HAE ingest must not touch gateway devices.");
      }),
    };
    const store = {
      ...genericStoreCalls,
      useRateLimit: vi.fn(async () => ({allowed: true})),
    } as unknown as GatewayServerOptions["store"];
    const worker = {
      close: vi.fn(async () => {}),
      poke: vi.fn(),
    } satisfies NonNullable<GatewayServerOptions["worker"]>;
    const server = await startGatewayServer({
      host: "127.0.0.1",
      port: 0,
      rateLimitPerMinute: 10_000,
      store,
      worker,
      haeJsonIngest: {
        token: HAE_TOKEN,
        inboxDir,
        maxBytes: 1024 * 1024,
        source: "synthetic-hae",
        clock: () => FIXED_NOW,
        idFactory: () => "hae-test-id",
      },
    });
    servers.push(server);
    return {
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
      genericStoreCalls,
      store,
      worker,
    };
  }

  it("accepts only safe metadata while writing the exact raw JSON bytes outside gateway events", async () => {
    const inboxDir = await createTempInbox();
    const harness = await startHaeServer(inboxDir);
    const payload = Buffer.from(`{\n  "data": {"metrics": [{"name":"${PRIVATE_MARKER}","value":1234}]}\n}\n`, "utf8");

    const response = await fetch(`${harness.baseUrl}${GATEWAY_HAE_JSON_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HAE_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    const body = await response.json() as {
      accepted: true;
      byteCount: number;
      filename: string;
      id: string;
      ok: true;
      source: string;
      timestamp: string;
    };
    expect(body).toEqual({
      ok: true,
      accepted: true,
      id: "hae-test-id",
      filename: "20260616T184500Z-hae-test-id.json",
      byteCount: payload.length,
      timestamp: FIXED_NOW.toISOString(),
      source: "synthetic-hae",
    });
    expect(JSON.stringify(body)).not.toContain(PRIVATE_MARKER);

    const storedBytes = await fs.readFile(path.join(inboxDir, body.filename));
    expect(storedBytes.equals(payload)).toBe(true);
    expect(await listDirSafe(inboxDir)).toEqual([body.filename]);
    expect(harness.store.useRateLimit).toHaveBeenCalledOnce();
    expect(harness.worker.poke).not.toHaveBeenCalled();
    for (const storeCall of Object.values(harness.genericStoreCalls)) {
      expect(storeCall).not.toHaveBeenCalled();
    }
  });

  it("rejects missing auth, invalid auth, wrong content type, and invalid JSON without storing payload bytes", async () => {
    const inboxDir = await createTempInbox();
    const harness = await startHaeServer(inboxDir);
    const validPayload = Buffer.from(`{"data":{"metrics":[{"name":"${PRIVATE_MARKER}"}]}}`, "utf8");

    const missingAuth = await fetch(`${harness.baseUrl}${GATEWAY_HAE_JSON_PATH}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: validPayload,
    });
    expect(missingAuth.status).toBe(401);

    const invalidAuth = await fetch(`${harness.baseUrl}${GATEWAY_HAE_JSON_PATH}`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: validPayload,
    });
    expect(invalidAuth.status).toBe(401);

    const wrongContentType = await fetch(`${harness.baseUrl}${GATEWAY_HAE_JSON_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HAE_TOKEN}`,
        "content-type": "text/plain",
      },
      body: validPayload,
    });
    expect(wrongContentType.status).toBe(415);

    const invalidJson = await fetch(`${harness.baseUrl}${GATEWAY_HAE_JSON_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HAE_TOKEN}`,
        "content-type": "application/json",
      },
      body: `{"data":"${PRIVATE_MARKER}"`,
    });
    expect(invalidJson.status).toBe(400);
    const invalidJsonText = await invalidJson.text();
    expect(invalidJsonText).toContain("HAE JSON payload must be valid JSON.");
    expect(invalidJsonText).not.toContain(PRIVATE_MARKER);

    expect(await listDirSafe(inboxDir)).toEqual([]);
    expect(harness.worker.poke).not.toHaveBeenCalled();
    for (const storeCall of Object.values(harness.genericStoreCalls)) {
      expect(storeCall).not.toHaveBeenCalled();
    }
  });

  it("writes inbox files via a temp file and rename", async () => {
    const inboxDir = "/synthetic/hae-inbox";
    const bytes = Buffer.from("{\"synthetic\":true}\n", "utf8");
    const files = new Map<string, Buffer>();
    const calls: string[] = [];
    const fileSystem: GatewayHaeJsonFileSystem = {
      mkdir: async (target) => {
        calls.push(`mkdir:${target}`);
      },
      writeFile: async (target, data) => {
        calls.push(`write:${path.basename(target)}`);
        expect(target).not.toBe(path.join(inboxDir, "20260616T184500Z-atomic-id.json"));
        expect(target).toContain(".20260616T184500Z-atomic-id.json.");
        files.set(target, Buffer.from(data));
      },
      rename: async (oldPath, newPath) => {
        calls.push(`rename:${path.basename(oldPath)}:${path.basename(newPath)}`);
        const tempBytes = files.get(oldPath);
        if (!tempBytes) {
          throw new Error("missing temp bytes");
        }
        files.delete(oldPath);
        files.set(newPath, tempBytes);
      },
      unlink: async (target) => {
        calls.push(`unlink:${path.basename(target)}`);
        files.delete(target);
      },
    };

    const written = await writeHaeJsonInboxFile({
      bytes,
      fileSystem,
      id: "atomic-id",
      inboxDir,
      now: FIXED_NOW,
    });

    expect(written).toMatchObject({
      filename: "20260616T184500Z-atomic-id.json",
      byteCount: bytes.length,
      timestamp: FIXED_NOW.toISOString(),
    });
    expect(files.get(path.join(inboxDir, written.filename))?.equals(bytes)).toBe(true);
    expect(calls[0]).toBe(`mkdir:${inboxDir}`);
    expect(calls[1]?.startsWith("write:.20260616T184500Z-atomic-id.json.")).toBe(true);
    expect(calls[2]?.startsWith("rename:.20260616T184500Z-atomic-id.json.")).toBe(true);
  });

  it("removes the temp file if the atomic rename fails", async () => {
    const inboxDir = "/synthetic/hae-inbox";
    const files = new Set<string>();
    let tempPath = "";
    const fileSystem: GatewayHaeJsonFileSystem = {
      mkdir: async () => {},
      writeFile: async (target) => {
        tempPath = target;
        files.add(target);
      },
      rename: async () => {
        throw new Error("synthetic rename failure");
      },
      unlink: async (target) => {
        files.delete(target);
      },
    };

    await expect(writeHaeJsonInboxFile({
      bytes: Buffer.from("{}", "utf8"),
      fileSystem,
      id: "rename-fails",
      inboxDir,
      now: FIXED_NOW,
    })).rejects.toThrow("synthetic rename failure");

    expect(tempPath).toContain(".20260616T184500Z-rename-fails.json.");
    expect(files.has(tempPath)).toBe(false);
    expect(files.has(path.join(inboxDir, "20260616T184500Z-rename-fails.json"))).toBe(false);
  });
});
