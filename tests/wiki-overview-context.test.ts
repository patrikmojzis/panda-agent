import {describe, expect, it, vi} from "vitest";

import {WikiOverviewContext} from "../src/panda/contexts/wiki-overview-context.js";

function createFetchImpl(payloads: {
  list: unknown;
  links: unknown;
}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: {
        limit?: number;
      };
    };
    if (body.query?.includes("query ListPages")) {
      const list = Array.isArray(payloads.list) && typeof body.variables?.limit === "number"
        ? payloads.list.slice(0, body.variables.limit)
        : payloads.list;
      return new Response(JSON.stringify({
        data: {
          pages: {
            list,
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }

    if (body.query?.includes("query ListPageLinks")) {
      return new Response(JSON.stringify({
        data: {
          pages: {
            links: payloads.links,
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }

    throw new Error(`Unexpected query: ${body.query ?? "<missing>"}`);
  }) as typeof fetch;
}

describe("WikiOverviewContext", () => {
  it("ranks recent pages and inbound links within the agent namespace and caches the snapshot", async () => {
    const fetchImpl = createFetchImpl({
      list: [
        {
          id: 1,
          path: "agents/panda/profile",
          locale: "en",
          title: "Profile",
          updatedAt: "2026-04-19T11:05:00.000Z",
        },
        {
          id: 2,
          path: "agents/panda/project-alpha",
          locale: "en",
          title: "Project Alpha",
          updatedAt: "2026-04-19T11:10:00.000Z",
        },
        {
          id: 3,
          path: "agents/otter/notes",
          locale: "en",
          title: "Otter Notes",
          updatedAt: "2026-04-19T11:20:00.000Z",
        },
        {
          id: 4,
          path: "agents/panda/_archive/2026/04/old-profile",
          locale: "en",
          title: "Old Profile",
          updatedAt: "2026-04-19T11:30:00.000Z",
        },
      ],
      links: [
        {
          id: 1,
          path: "en/agents/panda/project-alpha",
          title: "Project Alpha",
          links: ["en/agents/panda/profile"],
        },
        {
          id: 2,
          path: "en/agents/panda/logbook",
          title: "Logbook",
          links: ["en/agents/panda/profile", "en/agents/panda/project-alpha", "en/agents/otter/notes"],
        },
        {
          id: 3,
          path: "en/agents/panda/profile",
          title: "Profile",
          links: [],
        },
        {
          id: 4,
          path: "en/agents/panda/_archive/2026/04/old-profile",
          title: "Old Profile",
          links: ["en/agents/panda/profile"],
        },
      ],
    });

    let nowMs = Date.parse("2026-04-19T12:00:00.000Z");
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {
        getBinding: async () => ({
          agentKey: "panda",
          wikiGroupId: 1,
          namespacePath: "agents/panda",
          apiToken: "wiki-token",
          keyVersion: 1,
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:00.000Z",
        }),
      },
      env: {
        WIKI_URL: "http://wiki.internal:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl,
      ttlMs: 5 * 60_000,
      now: () => new Date(nowMs),
    });

    const first = await context.getContent();
    nowMs += 2 * 60_000;
    const second = await context.getContent();

    expect(first).toContain("Namespace: agents/panda");
    expect(first).toContain("Last refreshed: just now (cached up to 5m)");
    expect(first).toContain("- Project Alpha :: agents/panda/project-alpha (updated 2026-04-19T11:10:00.000Z)");
    expect(first).toContain("- Profile :: agents/panda/profile (2 inbound links)");
    expect(first).toContain("- Project Alpha :: agents/panda/project-alpha (1 inbound link)");
    expect(second).toContain("Last refreshed: 2m ago (cached up to 5m)");
    expect(first).not.toContain("Otter Notes");
    expect(first).not.toContain("Old Profile");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("renders an empty namespace without blowing up", async () => {
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {
        getBinding: async () => ({
          agentKey: "panda",
          wikiGroupId: 1,
          namespacePath: "agents/panda",
          apiToken: "wiki-token",
          keyVersion: 1,
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:00.000Z",
        }),
      },
      fetchImpl: createFetchImpl({
        list: [],
        links: [],
      }),
      ttlMs: 0,
    });

    const content = await context.getContent();

    expect(content).toContain("Namespace: agents/panda");
    expect(content).toContain("Last refreshed: just now");
    expect(content).toContain("- No pages yet.");
    expect(content).toContain("- No inbound links yet.");
  });

  it("falls back to the page slug when a linked target has no title", async () => {
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {
        getBinding: async () => ({
          agentKey: "panda",
          wikiGroupId: 1,
          namespacePath: "agents/panda",
          apiToken: "wiki-token",
          keyVersion: 1,
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:00.000Z",
        }),
      },
      fetchImpl: createFetchImpl({
        list: [
          {
            id: 1,
            path: "agents/panda/untitled",
            locale: "en",
            title: "",
            updatedAt: "2026-04-19T11:00:00.000Z",
          },
        ],
        links: [
          {
            id: 1,
            path: "en/agents/panda/source",
            title: "Source",
            links: ["en/agents/panda/untitled"],
          },
          {
            id: 2,
            path: "en/agents/panda/untitled",
            title: "",
            links: [],
          },
        ],
      }),
      ttlMs: 0,
    });

    const content = await context.getContent();

    expect(content).toContain("Last refreshed: just now");
    expect(content).toContain("- untitled :: agents/panda/untitled (1 inbound link)");
  });

  it("overfetches recent pages before namespace filtering so other agents do not crowd out the list", async () => {
    const fetchImpl = createFetchImpl({
      list: [
        ...Array.from({length: 12}, (_, index) => ({
          id: index + 1,
          path: `agents/otter/hot-${index + 1}`,
          locale: "en",
          title: `Otter Hot ${index + 1}`,
          updatedAt: `2026-04-19T11:${String(59 - index).padStart(2, "0")}:00.000Z`,
        })),
        {
          id: 20,
          path: "agents/panda/project-alpha",
          locale: "en",
          title: "Project Alpha",
          updatedAt: "2026-04-19T11:20:00.000Z",
        },
        {
          id: 21,
          path: "agents/panda/profile",
          locale: "en",
          title: "Profile",
          updatedAt: "2026-04-19T11:19:00.000Z",
        },
      ],
      links: [],
    });
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {
        getBinding: async () => ({
          agentKey: "panda",
          wikiGroupId: 1,
          namespacePath: "agents/panda",
          apiToken: "wiki-token",
          keyVersion: 1,
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:00.000Z",
        }),
      },
      fetchImpl,
      recentLimit: 2,
      ttlMs: 0,
    });

    const content = await context.getContent();
    const listRequest = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      variables?: {limit?: number};
    };

    expect(content).toContain("- Project Alpha :: agents/panda/project-alpha (updated 2026-04-19T11:20:00.000Z)");
    expect(content).toContain("- Profile :: agents/panda/profile (updated 2026-04-19T11:19:00.000Z)");
    expect(listRequest.variables?.limit).toBeGreaterThan(2);
  });
});
