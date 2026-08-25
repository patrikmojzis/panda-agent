import {setTimeout as delay} from "node:timers/promises";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

import {afterEach, describe, expect, it, vi} from "vitest";
import {getHttpStream} from "baileys/lib/Utils/messages-media.js";

describe("Baileys media abort patch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards AbortSignal while waiting for media response headers", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {once: true}),
    ));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await Promise.race([
      getHttpStream("https://media.invalid/example", {
        signal: AbortSignal.timeout(20),
      }).then(() => "resolved", () => "aborted"),
      delay(500, "hung"),
    ]);

    expect(outcome).toBe("aborted");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://media.invalid/example",
      expect.objectContaining({signal: expect.any(AbortSignal)}),
    );
  });

  it("bounds expired-media reupload waits with the socket query deadline", async () => {
    const sourcePath = fileURLToPath(import.meta.resolve("baileys/lib/Socket/messages-send.js"));
    const source = await readFile(sourcePath, "utf8");

    expect(source).toContain("}, config.defaultQueryTimeoutMs)");
  });
});
