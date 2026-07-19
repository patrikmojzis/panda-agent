import {describe, expect, it, vi} from "vitest";

import {WikiOverviewContext} from "../src/panda/contexts/wiki-overview-context.js";

function createFetchImpl(payloads: {list?: unknown; links: unknown}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {query?: string};
    const payload = body.query?.includes("query ListPages")
      ? {list: payloads.list ?? []}
      : body.query?.includes("query ListPageLinks")
        ? {links: payloads.links}
        : null;
    if (!payload) {
      throw new Error(`Unexpected query: ${body.query ?? "<missing>"}`);
    }

    return new Response(JSON.stringify({data: {pages: payload}}), {
      status: 200,
      headers: {"content-type": "application/json"},
    });
  }) as typeof fetch;
}

function createBinding(agentKey = "panda") {
  return {
    agentKey,
    wikiGroupId: 1,
    namespacePath: `agents/${agentKey}`,
    apiToken: "wiki-token",
    keyVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("WikiOverviewContext", () => {
  it("renders cache-stable key pages without activity metadata", async () => {
    const fetchImpl = createFetchImpl({
      links: [
        {
          id: 1,
          path: "en/agents/cache-panda/project-alpha",
          title: "Project Alpha",
          links: ["en/agents/cache-panda/profile"],
        },
        {
          id: 2,
          path: "en/agents/cache-panda/logbook",
          title: "Logbook",
          links: [
            "en/agents/cache-panda/profile",
            "en/agents/cache-panda/project-alpha",
            "en/agents/otter/notes",
          ],
        },
        {
          id: 3,
          path: "en/agents/cache-panda/profile",
          title: "Profile",
          links: [],
        },
        {
          id: 4,
          path: "en/agents/cache-panda/_archive/2026/04/old-profile",
          title: "Old Profile",
          links: ["en/agents/cache-panda/profile"],
        },
      ],
    });
    let nowMs = Date.parse("2026-04-19T12:00:00.000Z");
    const context = new WikiOverviewContext({
      agentKey: "cache-panda",
      bindings: {getBinding: async () => createBinding("cache-panda")},
      env: {WIKI_URL: "http://wiki.internal:3000"} as NodeJS.ProcessEnv,
      fetchImpl,
      ttlMs: 5 * 60_000,
      now: () => new Date(nowMs),
    });

    const first = await context.getContent();
    nowMs += 2 * 60_000;
    const second = await context.getContent();

    expect(first).toContain("Namespace: agents/cache-panda");
    expect(first).toContain("Key pages:");
    expect(first).toContain("- Project Alpha :: agents/cache-panda/project-alpha");
    expect(first).toContain("- Profile :: agents/cache-panda/profile");
    expect(first).toContain("Use `panda wiki overview` for recently edited pages and link details.");
    expect(first).not.toContain("Recently edited:");
    expect(first).not.toContain("updated ");
    expect(first).not.toContain("inbound link");
    expect(first).not.toContain("refreshes");
    expect(first).not.toContain("Otter Notes");
    expect(first).not.toContain("Old Profile");
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("renders an empty namespace without blowing up", async () => {
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {getBinding: async () => createBinding()},
      fetchImpl: createFetchImpl({links: []}),
      ttlMs: 0,
    });

    const content = await context.getContent();

    expect(content).toContain("Namespace: agents/panda");
    expect(content).toContain("Allowed scope: only this namespace and its child pages.");
    expect(content).toContain("- No linked pages yet.");
  });

  it("falls back to the page slug when a linked target has no title", async () => {
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {getBinding: async () => createBinding()},
      fetchImpl: createFetchImpl({
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

    await expect(context.getContent()).resolves.toContain("- untitled :: agents/panda/untitled");
  });

  it("keeps the twenty strongest pages but renders them in stable path order", async () => {
    const targets = Array.from({length: 25}, (_, index) => ({
      id: index + 1,
      path: `en/agents/panda/target-${index}`,
      title: `Target ${index}`,
      links: [],
    }));
    const sources = Array.from({length: 25}, (_, index) => ({
      id: 100 + index,
      path: `en/agents/panda/source-${index}`,
      title: `Source ${index}`,
      links: targets.slice(0, 25 - index).map((target) => target.path),
    }));
    const context = new WikiOverviewContext({
      agentKey: "panda",
      bindings: {getBinding: async () => createBinding()},
      fetchImpl: createFetchImpl({links: [...targets, ...sources]}),
      ttlMs: 0,
    });

    const content = await context.getContent();
    const keyPageLines = content.split("\n").filter((line) => line.startsWith("- Target"));

    expect(keyPageLines).toHaveLength(20);
    expect(keyPageLines).toContain("- Target 0 :: agents/panda/target-0");
    expect(keyPageLines).toContain("- Target 19 :: agents/panda/target-19");
    expect(keyPageLines).not.toContain("- Target 20 :: agents/panda/target-20");
    expect(keyPageLines.indexOf("- Target 10 :: agents/panda/target-10"))
      .toBeLessThan(keyPageLines.indexOf("- Target 2 :: agents/panda/target-2"));
  });
});
