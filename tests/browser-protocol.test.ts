import {describe, expect, it} from "vitest";

import {parseBrowserRunnerActionResponse} from "../src/integrations/browser/protocol.js";

describe("browser runner protocol", () => {
  it("parses successful runner responses", () => {
    expect(parseBrowserRunnerActionResponse({
      ok: true,
      text: "Snapshot ok",
      details: {
        action: "snapshot",
      },
      artifact: {
        kind: "image",
        mimeType: "image/png",
        data: Buffer.from("image").toString("base64"),
        bytes: 5,
        path: "/tmp/screenshot.png",
      },
    })).toEqual({
      ok: true,
      text: "Snapshot ok",
      details: {
        action: "snapshot",
      },
      artifact: {
        kind: "image",
        mimeType: "image/png",
        data: Buffer.from("image").toString("base64"),
        bytes: 5,
        path: "/tmp/screenshot.png",
      },
    });
  });

  it("parses runner error responses", () => {
    expect(parseBrowserRunnerActionResponse({
      ok: false,
      error: "Navigation failed.",
      details: {
        statusCode: 500,
      },
    })).toEqual({
      ok: false,
      error: "Navigation failed.",
      details: {
        statusCode: 500,
      },
    });
  });

  it("rejects malformed runner responses", () => {
    expect(() => parseBrowserRunnerActionResponse({
      ok: true,
      details: {
        action: "snapshot",
      },
    })).toThrow("Browser runner returned an invalid response.");

    expect(() => parseBrowserRunnerActionResponse({
      ok: false,
      error: 500,
    })).toThrow("Browser runner returned an invalid response.");

    expect(() => parseBrowserRunnerActionResponse({
      ok: true,
      text: "bad artifact",
      artifact: {
        kind: "image",
        mimeType: "image/png",
        data: "abc",
        bytes: "3",
        path: "/tmp/image.png",
      },
    })).toThrow("Browser runner returned an invalid response.");
  });
});
