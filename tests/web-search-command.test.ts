import {describe, expect, it, vi} from "vitest";

import {COMMAND_AUDIT_METADATA} from "../src/domain/commands/types.js";
import {
  BRAVE_LLM_CONTEXT_COMMAND_NAME,
  BRAVE_IMAGE_SEARCH_COMMAND_NAME,
  BRAVE_NEWS_SEARCH_COMMAND_NAME,
  BRAVE_PLACE_DESCRIPTION_COMMAND_NAME,
  BRAVE_PLACE_POI_COMMAND_NAME,
  BRAVE_PLACE_SEARCH_COMMAND_NAME,
  BRAVE_VIDEO_SEARCH_COMMAND_NAME,
  BRAVE_WEB_SEARCH_COMMAND_NAME,
  createBraveImageSearchCommand,
  createBraveLlmContextCommand,
  createBraveNewsSearchCommand,
  createBravePlaceDescriptionCommand,
  createBravePlacePoiCommand,
  createBravePlaceSearchCommand,
  createBraveVideoSearchCommand,
  createBraveWebSearchCommand,
} from "../src/integrations/web/commands.js";
import {BraveThrottleGate} from "../src/integrations/web/brave-throttle.js";

function braveWebSuccess(): Response {
  return new Response(JSON.stringify({web: {results: []}}), {
    status: 200,
    headers: {"content-type": "application/json"},
  });
}

function createFakeThrottleClock(startedAt = 0) {
  let current = startedAt;
  const waits: number[] = [];
  const now = () => current;
  const wait = vi.fn(async (delayMs: number, signal?: AbortSignal) => {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    waits.push(delayMs);
    current += delayMs;
  });
  return {
    now,
    wait,
    waits,
    gate: new BraveThrottleGate({now, wait}),
  };
}

describe("web search command", () => {
  it("returns structured Brave search results", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("q")).toBe("latest TypeScript release");
      expect(url.searchParams.get("count")).toBe("2");
      expect(url.searchParams.get("country")).toBe("ALL");
      expect(url.searchParams.get("freshness")).toBe("pw");
      expect(url.searchParams.get("search_lang")).toBe("jp");

      return new Response(JSON.stringify({
        web: {
          results: [{
            title: "TypeScript",
            url: "https://example.com/typescript",
            description: "Release notes.",
            age: "1 day ago",
          }],
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {
        query: "latest TypeScript release",
        count: 2,
        country: "vn",
        freshness: "week",
        search_lang: "ja",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      output: {
        provider: "brave",
        query: "latest TypeScript release",
        country: "ALL",
        freshness: "pw",
        elapsedMs: 0,
        moreResultsAvailable: null,
        resultCount: 1,
        safesearch: null,
        search_lang: "jp",
        results: [{
          title: "TypeScript",
          url: "https://example.com/typescript",
          snippet: "Release notes.",
          siteName: "example.com",
          published: "1 day ago",
        }],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("executes brave.web.search with native Brave search parameters", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/web/search");
      expect(url.searchParams.get("q")).toBe("durable CLI design");
      expect(url.searchParams.get("count")).toBe("3");
      expect(url.searchParams.get("offset")).toBe("1");
      expect(url.searchParams.get("freshness")).toBe("pd");
      expect(url.searchParams.get("safesearch")).toBe("strict");
      expect(url.searchParams.get("extra_snippets")).toBe("true");

      return new Response(JSON.stringify({
        query: {
          more_results_available: true,
        },
        web: {
          results: [{
            title: "CLI Design",
            url: "https://example.com/cli",
            description: "Useful command design.",
            extra_snippets: ["More context."],
          }],
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {
        query: "durable CLI design",
        count: 3,
        offset: 1,
        freshness: "pd",
        safesearch: "strict",
        extra_snippets: true,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "web",
      freshness: "pd",
      moreResultsAvailable: true,
      safesearch: "strict",
      results: [{
        extraSnippets: ["More context."],
      }],
    });
  });

  it("executes brave.news.search against the news endpoint", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/news/search");
      expect(url.searchParams.get("q")).toBe("AI regulation");
      expect(url.searchParams.get("freshness")).toBe("pd");

      return new Response(JSON.stringify({
        results: [{
          title: "AI regulation update",
          url: "https://news.example.com/ai",
          description: "Breaking coverage.",
          age: "2 hours ago",
        }],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBraveNewsSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_NEWS_SEARCH_COMMAND_NAME,
      input: {
        query: "AI regulation",
        freshness: "pd",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "news",
      resultCount: 1,
      results: [{
        title: "AI regulation update",
        published: "2 hours ago",
      }],
    });
  });

  it("executes brave.video.search against the video endpoint", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/videos/search");
      expect(url.searchParams.get("q")).toBe("machine learning tutorial");
      expect(url.searchParams.get("count")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("2");
      expect(url.searchParams.get("freshness")).toBe("pw");
      expect(url.searchParams.get("spellcheck")).toBe("false");

      return new Response(JSON.stringify({
        results: [{
          title: "Machine learning tutorial",
          url: "https://video.example.com/ml",
          description: "A good tutorial.",
          age: "3 days ago",
        }],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBraveVideoSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_VIDEO_SEARCH_COMMAND_NAME,
      input: {
        query: "machine learning tutorial",
        count: 10,
        offset: 2,
        freshness: "pw",
        spellcheck: false,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "video",
      resultCount: 1,
      results: [{
        title: "Machine learning tutorial",
        published: "3 days ago",
      }],
    });
  });

  it("executes brave.image.search against the image endpoint", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/images/search");
      expect(url.searchParams.get("q")).toBe("modern architecture");
      expect(url.searchParams.get("count")).toBe("25");
      expect(url.searchParams.get("safesearch")).toBe("strict");
      expect(url.searchParams.has("freshness")).toBe(false);
      expect(url.searchParams.has("offset")).toBe(false);

      return new Response(JSON.stringify({
        results: [{
          title: "Modern Architecture",
          url: "https://page.example.com/architecture",
          description: "Glass building.",
          thumbnail: {
            src: "https://thumb.example.com/architecture.jpg",
          },
          properties: {
            url: "https://images.example.com/architecture.jpg",
            placeholder: "https://thumb.example.com/placeholder.jpg",
            width: 1200,
            height: 800,
          },
        }],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBraveImageSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_IMAGE_SEARCH_COMMAND_NAME,
      input: {
        query: "modern architecture",
        count: 25,
        safesearch: "strict",
        freshness: "pd",
        offset: 1,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "image",
      resultCount: 1,
      results: [{
        title: "Modern Architecture",
        sourcePageUrl: "https://page.example.com/architecture",
        originalImageUrl: "https://images.example.com/architecture.jpg",
        width: 1200,
        height: 800,
      }],
    });
  });

  it("executes brave.llm.context with context budget parameters", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/llm/context");
      expect(url.searchParams.get("q")).toBe("durable agent command architecture");
      expect(url.searchParams.get("maximum_number_of_tokens")).toBe("8192");
      expect(url.searchParams.get("maximum_number_of_urls")).toBe("5");
      expect(url.searchParams.get("context_threshold_mode")).toBe("strict");
      expect(url.searchParams.get("enable_local")).toBe("true");

      return new Response(JSON.stringify({
        grounding: {
          generic: [{
            url: "https://example.com/commands",
            title: "Commands",
            snippets: ["Command interfaces should be boring."],
          }],
        },
        sources: {
          "https://example.com/commands": {
            title: "Commands",
            hostname: "example.com",
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBraveLlmContextCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_LLM_CONTEXT_COMMAND_NAME,
      input: {
        query: "durable agent command architecture",
        maximum_number_of_tokens: 8192,
        maximum_number_of_urls: 5,
        context_threshold_mode: "strict",
        enable_local: true,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "llm_context",
      resultCount: 1,
      grounding: {
        generic: [{
          title: "Commands",
        }],
      },
      sources: {
        "https://example.com/commands": {
          hostname: "example.com",
        },
      },
    });
  });

  it("executes brave.place.search against the place endpoint", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/local/place_search");
      expect(url.searchParams.get("q")).toBe("restaurants");
      expect(url.searchParams.get("location")).toBe("san francisco ca united states");
      expect(url.searchParams.get("count")).toBe("10");
      expect(url.searchParams.get("units")).toBe("imperial");
      expect(url.searchParams.get("spellcheck")).toBe("false");

      return new Response(JSON.stringify({
        results: [{
          id: "loc123",
          title: "Good Restaurant",
          url: "https://example.com/good",
          description: "Dinner place.",
          coordinates: [37.78, -122.42],
          rating: {ratingValue: 4.5},
          distance: {value: 120, units: "m"},
        }],
        location: {
          name: "San Francisco",
          country: "US",
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const command = createBravePlaceSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: () => 100,
    });

    const result = await command.execute({
      command: BRAVE_PLACE_SEARCH_COMMAND_NAME,
      input: {
        query: "restaurants",
        location: "san francisco ca united states",
        count: 10,
        units: "imperial",
        spellcheck: false,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "place",
      query: "restaurants",
      locationInput: "san francisco ca united states",
      resultCount: 1,
      places: [{
        id: "loc123",
        title: "Good Restaurant",
        coordinates: [37.78, -122.42],
      }],
      location: {
        name: "San Francisco",
      },
    });
  });

  it("executes brave.place.poi and description detail calls with repeated ids", async () => {
    const poiFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/local/pois");
      expect(url.searchParams.getAll("ids")).toEqual(["loc1", "loc2"]);

      return new Response(JSON.stringify({
        results: [{
          id: "loc1",
          profiles: [],
        }],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });
    const descriptionFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/res/v1/local/descriptions");
      expect(url.searchParams.getAll("ids")).toEqual(["loc1"]);

      return new Response(JSON.stringify({
        descriptions: [{
          id: "loc1",
          description: "AI description.",
        }],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });

    const poi = await createBravePlacePoiCommand({
      apiKey: "BSA-test-key",
      fetchImpl: poiFetch,
      now: () => 100,
    }).execute({
      command: BRAVE_PLACE_POI_COMMAND_NAME,
      input: {
        ids: ["loc1", "loc2"],
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });
    const description = await createBravePlaceDescriptionCommand({
      apiKey: "BSA-test-key",
      fetchImpl: descriptionFetch,
      now: () => 100,
    }).execute({
      command: BRAVE_PLACE_DESCRIPTION_COMMAND_NAME,
      input: {
        id: "loc1",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(poi.output).toMatchObject({
      provider: "brave",
      vertical: "place_poi",
      ids: ["loc1", "loc2"],
      resultCount: 1,
      payload: {
        results: [{
          id: "loc1",
        }],
      },
    });
    expect(description.output).toMatchObject({
      provider: "brave",
      vertical: "place_description",
      ids: ["loc1"],
      resultCount: 1,
      payload: {
        descriptions: [{
          description: "AI description.",
        }],
      },
    });
  });

  it("absorbs a short 429 and preserves the successful result contract", async () => {
    const clock = createFakeThrottleClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("provider-secret-body", {
        status: 429,
        headers: {"retry-after": "2"},
      }))
      .mockResolvedValueOnce(braveWebSuccess());
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      throttleGate: clock.gate,
    });

    const result = await command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "retry without another turn"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(result.output).toMatchObject({
      provider: "brave",
      vertical: "web",
      query: "retry without another turn",
      resultCount: 0,
    });
    expect(result[COMMAND_AUDIT_METADATA]).toEqual({attemptCount: 2, totalBackoffMs: 2_000});
    expect(JSON.stringify(result)).not.toContain("attemptCount");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.waits).toEqual([2_000]);
  });

  it("stops after three physical attempts with deterministic equal jitter", async () => {
    const clock = createFakeThrottleClock();
    const fetchImpl = vi.fn(async () => new Response("provider-secret-body", {status: 429}));
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      random: () => 0,
      throttleGate: clock.gate,
    });

    await expect(command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "bounded retries"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      message: "Brave Search remained rate limited after bounded retries.",
      pandaCommandErrorCode: "rate_limited",
      pandaCommandErrorDetails: {
        provider: "brave",
        status: 429,
        failureCode: "rate_limited",
        retryable: true,
        attemptCount: 3,
        totalBackoffMs: 5_000,
        autoRetryExhausted: true,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.waits).toEqual([1_000, 4_000]);
  });

  it("parses Retry-After HTTP dates", async () => {
    const startedAt = Date.UTC(2026, 6, 19, 12, 0, 0);
    const clock = createFakeThrottleClock(startedAt);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: {"retry-after": new Date(startedAt + 8_000).toUTCString()},
      }))
      .mockResolvedValueOnce(braveWebSuccess());
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      throttleGate: clock.gate,
    });

    await command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "date retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(clock.waits).toEqual([8_000]);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "later-ish"],
    ["past", "Sat, 18 Jul 2026 12:00:00 GMT"],
  ])("uses injected jitter for %s Retry-After", async (_label, retryAfter) => {
    const startedAt = Date.UTC(2026, 6, 19, 12, 0, 0);
    const clock = createFakeThrottleClock(startedAt);
    const headers = retryAfter ? {"retry-after": retryAfter} : undefined;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, {status: 429, headers}))
      .mockResolvedValueOnce(braveWebSuccess());
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      random: () => 0.5,
      throttleGate: clock.gate,
    });

    await command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "fallback retry"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(clock.waits).toEqual([1_500]);
  });

  it("returns promptly when the provider delay exceeds the retry budget", async () => {
    const clock = createFakeThrottleClock();
    const fetchImpl = vi.fn(async () => new Response("provider-secret-body", {
      status: 429,
      headers: {"retry-after": "60", "x-provider-secret": "do-not-return"},
    }));
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      throttleGate: clock.gate,
    });

    await expect(command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "long cooldown"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: {
        retryable: true,
        retryAfterMs: 60_000,
        attemptCount: 1,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.waits).toEqual([]);

    await expect(command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "immediate retry"},
      scope: {agentKey: "panda", sessionId: "session-2"},
    })).rejects.toMatchObject({
      pandaCommandErrorDetails: {
        retryable: true,
        retryAfterMs: 60_000,
        attemptCount: 0,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the documented exhausted Brave reset window without selecting the monthly reset", async () => {
    const clock = createFakeThrottleClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: {
          "x-ratelimit-policy": "1;w=1, 15000;w=2592000",
          "x-ratelimit-remaining": "0, 14523",
          "x-ratelimit-reset": "3, 1234567",
        },
      }))
      .mockResolvedValueOnce(braveWebSuccess());
    const command = createBraveWebSearchCommand({
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      throttleGate: clock.gate,
    });

    await command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "documented reset"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    });

    expect(clock.waits).toEqual([3_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403])("never retries terminal HTTP %s", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("provider-secret-body", {status}));
    const command = createBraveWebSearchCommand({apiKey: "BSA-test-key", fetchImpl});

    await expect(command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "terminal status"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toThrow(`Brave Search API request failed with status ${status}.`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares explicit quota exhaustion across every Brave vertical", async () => {
    const clock = createFakeThrottleClock();
    const fetchImpl = vi.fn(async () => new Response("provider-secret-body", {
      status: 429,
      headers: {
        "x-ratelimit-policy": "1;w=1, 15000;w=2592000",
        "x-ratelimit-remaining": "0, 0",
        "x-ratelimit-reset": "1, 86400",
      },
    }));
    const options = {
      apiKey: "BSA-test-key",
      fetchImpl,
      now: clock.now,
      throttleGate: clock.gate,
    };
    const web = createBraveWebSearchCommand(options);

    await expect(web.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "quota"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      message: "Brave Search quota is exhausted.",
      pandaCommandErrorDetails: {
        failureCode: "quota_exhausted",
        retryable: false,
        attemptCount: 1,
        retryAfterMs: 86_400_000,
      },
    });

    const blockedCalls = [
      createBraveNewsSearchCommand(options).execute({command: BRAVE_NEWS_SEARCH_COMMAND_NAME, input: {query: "news"}, scope: {agentKey: "panda", sessionId: "s"}}),
      createBraveVideoSearchCommand(options).execute({command: BRAVE_VIDEO_SEARCH_COMMAND_NAME, input: {query: "video"}, scope: {agentKey: "panda", sessionId: "s"}}),
      createBraveImageSearchCommand(options).execute({command: BRAVE_IMAGE_SEARCH_COMMAND_NAME, input: {query: "image"}, scope: {agentKey: "panda", sessionId: "s"}}),
      createBraveLlmContextCommand(options).execute({command: BRAVE_LLM_CONTEXT_COMMAND_NAME, input: {query: "context"}, scope: {agentKey: "panda", sessionId: "s"}}),
      createBravePlaceSearchCommand(options).execute({command: BRAVE_PLACE_SEARCH_COMMAND_NAME, input: {query: "place"}, scope: {agentKey: "panda", sessionId: "s"}}),
      createBravePlacePoiCommand(options).execute({command: BRAVE_PLACE_POI_COMMAND_NAME, input: {ids: ["loc1"]}, scope: {agentKey: "panda", sessionId: "s"}}),
      createBravePlaceDescriptionCommand(options).execute({command: BRAVE_PLACE_DESCRIPTION_COMMAND_NAME, input: {ids: ["loc1"]}, scope: {agentKey: "panda", sessionId: "s"}}),
    ];
    const blocked = await Promise.allSettled(blockedCalls);
    expect(blocked.every((result) => result.status === "rejected")).toBe(true);
    for (const result of blocked) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          pandaCommandErrorDetails: {retryable: false, attemptCount: 0},
        });
      }
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a shared cooldown wait without launching another attempt", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 429,
      headers: {"retry-after": "5"},
    }));
    const command = createBraveWebSearchCommand({apiKey: "BSA-test-key", fetchImpl});
    const execution = command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "cancel wait"},
      scope: {agentKey: "panda", sessionId: "session-1"},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(execution).rejects.toThrow("Brave search was aborted.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes cancellation into the physical Brave fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {once: true});
      })
    ));
    const command = createBraveWebSearchCommand({apiKey: "BSA-test-key", fetchImpl});
    const execution = command.execute({
      command: BRAVE_WEB_SEARCH_COMMAND_NAME,
      input: {query: "cancel fetch"},
      scope: {agentKey: "panda", sessionId: "session-1"},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(execution).rejects.toThrow("Brave search was aborted.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("BraveThrottleGate", () => {
  it("rejects excess cooldown waiters instead of growing an unbounded queue", async () => {
    const controller = new AbortController();
    const wait = vi.fn((_delayMs: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {once: true});
    }));
    const gate = new BraveThrottleGate({wait, maxWaiters: 1});
    const initial = await gate.acquire({deadlineMs: Date.now() + 15_000});
    expect(initial.allowed).toBe(true);
    if (!initial.allowed) return;
    gate.reportRateLimit({
      permit: initial.permit,
      retryAfterMs: 1_000,
      retryable: true,
      failureCode: "rate_limited",
    });

    const first = gate.acquire({deadlineMs: Date.now() + 15_000, signal: controller.signal});
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    await expect(gate.acquire({deadlineMs: Date.now() + 15_000})).resolves.toMatchObject({
      allowed: false,
      retryable: true,
      failureCode: "rate_limited",
    });
    controller.abort();
    await expect(first).rejects.toBeDefined();
  });

  it("allows one probe and paces a concurrent waiter after recovery", async () => {
    let current = 0;
    const pendingWaits: Array<{delayMs: number; finish(): void}> = [];
    const wait = vi.fn((delayMs: number) => new Promise<void>((resolve) => {
      const target = current + delayMs;
      pendingWaits.push({
        delayMs,
        finish() {
          current = Math.max(current, target);
          resolve();
        },
      });
    }));
    const gate = new BraveThrottleGate({now: () => current, wait, recoveryPaceMs: 100});
    const initial = await gate.acquire({deadlineMs: 15_000});
    expect(initial.allowed).toBe(true);
    if (!initial.allowed) return;
    gate.reportRateLimit({
      permit: initial.permit,
      retryAfterMs: 1_000,
      retryable: true,
      failureCode: "rate_limited",
    });

    const first = gate.acquire({deadlineMs: 15_000});
    const second = gate.acquire({deadlineMs: 15_000});
    await vi.waitFor(() => expect(pendingWaits).toHaveLength(2));
    pendingWaits.splice(0, 2).forEach((entry) => entry.finish());
    const probe = await Promise.race([
      first.then((result) => ({source: "first" as const, result})),
      second.then((result) => ({source: "second" as const, result})),
    ]);
    expect(probe.result).toMatchObject({allowed: true, permit: {probe: true}});
    if (!probe.result.allowed) return;
    const waiter = probe.source === "first" ? second : first;
    gate.reportNonRateLimited(probe.result.permit);
    await vi.waitFor(() => expect(pendingWaits).toHaveLength(1));
    expect(pendingWaits[0]?.delayMs).toBe(100);
    pendingWaits.shift()?.finish();

    await expect(waiter).resolves.toMatchObject({allowed: true, permit: {probe: false}});
  });
});
