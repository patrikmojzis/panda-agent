import {describe, expect, it, vi} from "vitest";

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
});
