import {describe, expect, it} from "vitest";

import {
  buildWorkerSessionMetadata,
  readWorkerContextValue,
  readWorkerSessionMetadata,
} from "../src/domain/sessions/worker-metadata.js";

describe("worker session metadata", () => {
  it("builds one durable worker context used by sessions and threads", () => {
    const metadata = buildWorkerSessionMetadata({
      metadata: {
        existing: true,
      },
      role: "research",
      task: "Inspect the package graph.",
      context: "Keep it read-only.",
      parentSessionId: "parent-session",
    });

    expect(readWorkerSessionMetadata(metadata)).toEqual({
      role: "research",
      task: "Inspect the package graph.",
      context: "Keep it read-only.",
      parentSessionId: "parent-session",
    });
    expect(readWorkerContextValue(metadata)).toEqual({
      role: "research",
      task: "Inspect the package graph.",
      context: "Keep it read-only.",
      parentSessionId: "parent-session",
    });
  });

  it("reads legacy string metadata without leaking malformed worker values", () => {
    expect(readWorkerContextValue(JSON.stringify({
      worker: {
        role: "audit",
      },
    }))).toEqual({
      role: "audit",
    });

    expect(readWorkerContextValue({
      worker: Number.NaN,
    })).toBeUndefined();
  });
});
