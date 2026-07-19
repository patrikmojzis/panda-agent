import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import {afterEach, describe, expect, it} from "vitest";

import {fetchWithPinnedLookup} from "../src/integrations/web/web-fetch.js";
import type {PinnedLookup} from "../src/integrations/web/safe-web-target.js";

describe("web fetch pinned HTTP transport", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  });

  async function serve(handler: Parameters<typeof createServer>[0]): Promise<URL> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return new URL(`http://example.test:${address.port}/resource`);
  }

  const loopbackLookup: PinnedLookup = (_hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    if (typeof options === "object" && options.all) {
      done?.(null, [{address: "127.0.0.1", family: 4}]);
      return;
    }
    done?.(null, "127.0.0.1", 4);
  };

  it("preserves successful binary response bytes", async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    const url = await serve((_request, response) => {
      response.writeHead(200, {"content-type": "application/octet-stream"});
      response.end(bytes);
    });

    const result = await fetchWithPinnedLookup(url, {
      lookup: loopbackLookup,
      headers: {},
      maxBytes: 10,
      method: "GET",
      readErrorBody: false,
    });

    expect(Buffer.from(result.bodyBytes)).toEqual(bytes);
  });

  it("stops before reading a success body whose declared size exceeds policy", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, {"content-length": "20", "content-type": "text/plain"});
      response.end("01234567890123456789");
    });

    await expect(fetchWithPinnedLookup(url, {
      lookup: loopbackLookup,
      headers: {},
      maxBytes: 4,
      method: "GET",
      readErrorBody: false,
    })).rejects.toThrow("exceeded the 4 byte limit before reading the body");
  });

  it("returns terminal status metadata without downloading its oversized error body", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(403, {"content-length": "20", "content-type": "text/plain"});
      response.end("SECRET_RESPONSE_BODY");
    });

    const result = await fetchWithPinnedLookup(url, {
      lookup: loopbackLookup,
      headers: {},
      maxBytes: 4,
      method: "GET",
      readErrorBody: false,
    });

    expect(result).toMatchObject({status: 403, bodyText: ""});
    expect(result.bodyBytes).toHaveLength(0);
  });
});
