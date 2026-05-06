import {describe, expect, it, vi} from "vitest";

import type {WatchRecord} from "../src/domain/watches/index.js";
import {evaluateWatch} from "../src/integrations/watches/evaluator.js";

function createCredentialResolver() {
  return {
    resolveCredential: vi.fn(async (envKey: string) => ({
      id: envKey,
      envKey,
      value: `${envKey}-value`,
      agentKey: "panda",
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

function createWatch(overrides: Partial<WatchRecord>): WatchRecord {
  return {
    id: "watch-1",
    sessionId: "session-1",
    title: "watch",
    intervalMinutes: 5,
    source: {
      kind: "http_json",
      url: "https://example.com/data",
      result: {
        observation: "scalar",
        valuePath: "value",
      },
    },
    detector: {
      kind: "percent_change",
      percent: 10,
    },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("evaluateWatch HTTP sources", () => {
  const lookupHostname = async () => ["93.184.216.34"];

  it("fires http_json percent watches only when the threshold is crossed and resets baseline", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({price: 100}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({price: 108}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({price: 112}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({price: 120}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));
    const credentialResolver = createCredentialResolver();
    const watch = createWatch({
      title: "BTC",
      source: {
        kind: "http_json",
        url: "https://example.com/btc",
        result: {
          observation: "scalar",
          valuePath: "price",
          label: "BTC",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    const first = await evaluateWatch(watch, {
      credentialResolver: credentialResolver as any,
      credentialContext: {agentKey: "panda"},
      fetchImpl,
      lookupHostname,
    });
    expect(first.changed).toBe(false);
    expect(first.nextState).toMatchObject({
      kind: "percent_change",
      baseline: 100,
      lastValue: 100,
    });

    const second = await evaluateWatch({
      ...watch,
      state: first.nextState,
    }, {
      credentialResolver: credentialResolver as any,
      credentialContext: {agentKey: "panda"},
      fetchImpl,
      lookupHostname,
    });
    expect(second.changed).toBe(false);
    expect(second.nextState).toMatchObject({
      baseline: 100,
      lastValue: 108,
    });

    const third = await evaluateWatch({
      ...watch,
      state: second.nextState,
    }, {
      credentialResolver: credentialResolver as any,
      credentialContext: {agentKey: "panda"},
      fetchImpl,
      lookupHostname,
    });
    expect(third.changed).toBe(true);
    expect(third.event?.eventKind).toBe("percent_change");
    expect(third.event?.payload).toMatchObject({
      baseline: 100,
      current: 112,
      thresholdPercent: 10,
    });
    expect(third.nextState).toMatchObject({
      baseline: 112,
      lastValue: 112,
    });

    const fourth = await evaluateWatch({
      ...watch,
      state: third.nextState,
    }, {
      credentialResolver: credentialResolver as any,
      credentialContext: {agentKey: "panda"},
      fetchImpl,
      lookupHostname,
    });
    expect(fourth.changed).toBe(false);
    expect(fourth.nextState).toMatchObject({
      baseline: 112,
      lastValue: 120,
    });
  });

  it("emits previous and current excerpts when http_html snapshots change", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("<html><body><main>Old property listing</main></body></html>", {
        status: 200,
        headers: {"content-type": "text/html; charset=utf-8"},
      }))
      .mockResolvedValueOnce(new Response("<html><body><main>New property listing with balcony</main></body></html>", {
        status: 200,
        headers: {"content-type": "text/html; charset=utf-8"},
      }));
    const credentialResolver = createCredentialResolver();
    const watch = createWatch({
      title: "Listings",
      source: {
        kind: "http_html",
        url: "https://example.com/listings",
        result: {
          observation: "snapshot",
          mode: "selector_text",
          selector: "main",
        },
      },
      detector: {
        kind: "snapshot_changed",
        excerptChars: 80,
      },
    });

    const first = await evaluateWatch(watch, {
      credentialResolver: credentialResolver as any,
      credentialContext: {agentKey: "panda"},
      fetchImpl,
      lookupHostname,
    });
    expect(first.changed).toBe(false);
    expect(first.nextState).toMatchObject({
      kind: "snapshot_changed",
      excerpt: "Old property listing",
    });

    const second = await evaluateWatch({
      ...watch,
      state: first.nextState,
    }, {
      credentialResolver: credentialResolver as any,
      credentialContext: {agentKey: "panda"},
      fetchImpl,
      lookupHostname,
    });
    expect(second.changed).toBe(true);
    expect(second.event).toMatchObject({
      eventKind: "snapshot_changed",
      summary: "Observed content changed.",
    });
    expect(second.event?.payload).toMatchObject({
      previousExcerpt: "Old property listing",
      currentExcerpt: "New property listing with balcony",
    });
  });
});
