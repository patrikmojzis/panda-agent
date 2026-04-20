import {describe, expect, it, vi} from "vitest";

import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import {Agent} from "../src/kernel/agent/agent.js";
import {RunContext} from "../src/kernel/agent/run-context.js";
import type {ToolResultPayload} from "../src/kernel/agent/types.js";
import {WikiTool} from "../src/panda/tools/wiki-tool.js";

function createRunContext(
  context: DefaultAgentSessionContext,
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "wiki-test-agent",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

function parseToolResult(result: ToolResultPayload): Record<string, unknown> {
  const textPart = result.content.find((part) => part.type === "text");
  if (!textPart) {
    throw new Error("Expected text output.");
  }

  return result.details as Record<string, unknown>;
}

function createBindings() {
  return {
    getBinding: vi.fn(async () => ({
      agentKey: "panda",
      wikiGroupId: 5,
      namespacePath: "agents/panda",
      apiToken: "agent-token",
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

function buildPage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 9,
    path: "agents/panda/profile",
    locale: "en",
    title: "Profile",
    description: "Profile page.",
    content: "# Panda",
    editor: "markdown",
    isPublished: true,
    isPrivate: false,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:01:00.000Z",
    tags: [{tag: "profile"}],
    ...overrides,
  };
}

function getRequestBody(fetchImpl: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const body = fetchImpl.mock.calls[callIndex]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error(`Expected string body at call ${callIndex}.`);
  }

  return JSON.parse(body) as Record<string, unknown>;
}

describe("WikiTool", () => {
  it("creates a missing page using the agent-scoped wiki token", async () => {
    const bindings = createBindings();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{message: "Page not found"}],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            create: {
              responseResult: {
                succeeded: true,
                message: "created",
              },
              page: {id: 9},
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage(),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "write",
      path: "/agents/panda/profile/",
      locale: "en",
      title: "Profile",
      description: "Profile page.",
      content: "# Panda",
      tags: ["profile"],
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "write",
      action: "created",
    });
    expect(bindings.getBinding).toHaveBeenCalledWith("panda");
  });

  it("filters search results to the requested namespace in Panda instead of relying on Wiki.js path matching", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            search: {
              results: [
                {
                  id: "1",
                  path: "agents/panda/profile",
                  locale: "en",
                  title: "Profile",
                  description: "Inside panda.",
                },
                {
                  id: "2",
                  path: "agents/panda/profile/history",
                  locale: "en",
                  title: "Profile History",
                  description: "Still inside panda.",
                },
                {
                  id: "archive-1",
                  path: "agents/panda/_archive/2026/04/profile-old",
                  locale: "en",
                  title: "Old Profile",
                  description: "Archived.",
                },
                {
                  id: "3",
                  path: "agents/otter/profile",
                  locale: "en",
                  title: "Otter Profile",
                  description: "Outside panda.",
                },
              ],
              suggestions: [],
              totalHits: 3,
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "search",
      query: "profile",
      path: "agents/panda/profile",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "search",
      path: "agents/panda/profile",
      totalHits: 2,
      results: [
        expect.objectContaining({path: "agents/panda/profile"}),
        expect.objectContaining({path: "agents/panda/profile/history"}),
      ],
    });
    expect(getRequestBody(fetchImpl, 0)).toMatchObject({
      variables: {
        query: "profile",
        locale: "en",
      },
    });
    expect(getRequestBody(fetchImpl, 0)).not.toHaveProperty("variables.path");
  });

  it("includes archived results only when searching inside the archive path explicitly", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            search: {
              results: [
                {
                  id: "archive-1",
                  path: "agents/panda/_archive/2026/04/profile-old",
                  locale: "en",
                  title: "Old Profile",
                  description: "Archived.",
                },
                {
                  id: "1",
                  path: "agents/panda/profile",
                  locale: "en",
                  title: "Profile",
                  description: "Active.",
                },
              ],
              suggestions: [],
              totalHits: 2,
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "search",
      query: "profile",
      path: "agents/panda/_archive",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "search",
      path: "agents/panda/_archive",
      totalHits: 1,
      results: [
        expect.objectContaining({path: "agents/panda/_archive/2026/04/profile-old"}),
      ],
    });
  });

  it("lists pages under a subtree and hides archived pages by default", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            list: [
              {
                id: 1,
                path: "agents/panda/finance",
                locale: "en",
                title: "Finance",
                updatedAt: "2026-04-19T10:00:00.000Z",
              },
              {
                id: 2,
                path: "agents/panda/finance/ledger",
                locale: "en",
                title: "Ledger",
                updatedAt: "2026-04-19T10:01:00.000Z",
              },
              {
                id: 3,
                path: "agents/panda/_archive/2026/04/finance-old",
                locale: "en",
                title: "Old Finance",
                updatedAt: "2026-04-19T10:02:00.000Z",
              },
              {
                id: 4,
                path: "agents/otter/finance",
                locale: "en",
                title: "Otter Finance",
                updatedAt: "2026-04-19T10:03:00.000Z",
              },
            ],
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "list",
      path: "agents/panda/finance",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "list",
      path: "agents/panda/finance",
      count: 2,
      totalPages: 2,
      truncated: false,
      includeArchived: false,
      pages: [
        expect.objectContaining({path: "agents/panda/finance"}),
        expect.objectContaining({path: "agents/panda/finance/ledger"}),
      ],
    });
    expect(getRequestBody(fetchImpl, 0)).toMatchObject({
      variables: {
        limit: 1000,
        locale: "en",
        orderBy: "PATH",
        orderByDirection: "ASC",
      },
    });
  });

  it("lists from the namespace root by default and truncates to the requested limit", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            list: [
              {
                id: 1,
                path: "agents/panda/alpha",
                locale: "en",
                title: "Alpha",
                updatedAt: "2026-04-19T10:00:00.000Z",
              },
              {
                id: 2,
                path: "agents/panda/beta",
                locale: "en",
                title: "Beta",
                updatedAt: "2026-04-19T10:01:00.000Z",
              },
              {
                id: 3,
                path: "agents/panda/gamma",
                locale: "en",
                title: "Gamma",
                updatedAt: "2026-04-19T10:02:00.000Z",
              },
              {
                id: 4,
                path: "agents/panda/_archive/2026/04/old-gamma",
                locale: "en",
                title: "Old Gamma",
                updatedAt: "2026-04-19T10:03:00.000Z",
              },
            ],
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "list",
      limit: 2,
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "list",
      path: "agents/panda",
      count: 2,
      totalPages: 3,
      truncated: true,
      pages: [
        expect.objectContaining({path: "agents/panda/alpha"}),
        expect.objectContaining({path: "agents/panda/beta"}),
      ],
    });
  });

  it("includes archived pages when listing inside the archive subtree", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            list: [
              {
                id: 1,
                path: "agents/panda/_archive/2026/04/finance-old",
                locale: "en",
                title: "Old Finance",
                updatedAt: "2026-04-19T10:02:00.000Z",
              },
              {
                id: 2,
                path: "agents/panda/finance",
                locale: "en",
                title: "Finance",
                updatedAt: "2026-04-19T10:00:00.000Z",
              },
            ],
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "list",
      path: "agents/panda/_archive",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "list",
      path: "agents/panda/_archive",
      count: 1,
      totalPages: 1,
      includeArchived: true,
      pages: [
        expect.objectContaining({path: "agents/panda/_archive/2026/04/finance-old"}),
      ],
    });
  });

  it("replaces an existing section through write_section", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 12,
              content: [
                "# Profile",
                "",
                "## Facts",
                "",
                "Old facts.",
                "",
                "## Links",
                "",
                "- one",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            update: {
              responseResult: {
                succeeded: true,
                message: "updated",
              },
              page: {id: 12},
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 12,
              updatedAt: "2026-04-19T10:05:00.000Z",
              content: [
                "# Profile",
                "",
                "## Facts",
                "",
                "New facts.",
                "",
                "- clean",
                "",
                "## Links",
                "",
                "- one",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "write_section",
      path: "agents/panda/profile",
      section: "Facts",
      content: [
        "New facts.",
        "",
        "- clean",
      ].join("\n"),
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "write_section",
      action: "updated",
      section: {
        title: "Facts",
        action: "replaced",
      },
    });
    expect(getRequestBody(fetchImpl, 1)).toMatchObject({
      variables: {
        content: [
          "# Profile",
          "",
          "## Facts",
          "",
          "New facts.",
          "",
          "- clean",
          "",
          "## Links",
          "",
          "- one",
        ].join("\n"),
      },
    });
  });

  it("appends a missing section through write_section", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 13,
              content: [
                "# Profile",
                "",
                "## Summary",
                "",
                "Already here.",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            update: {
              responseResult: {
                succeeded: true,
                message: "updated",
              },
              page: {id: 13},
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 13,
              updatedAt: "2026-04-19T10:06:00.000Z",
              content: [
                "# Profile",
                "",
                "## Summary",
                "",
                "Already here.",
                "",
                "## Facts",
                "",
                "- likes tea",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "write_section",
      path: "agents/panda/profile",
      section: "Facts",
      content: "- likes tea",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "write_section",
      action: "updated",
      section: {
        title: "Facts",
        action: "appended",
      },
    });
    expect(getRequestBody(fetchImpl, 1)).toMatchObject({
      variables: {
        content: [
          "# Profile",
          "",
          "## Summary",
          "",
          "Already here.",
          "",
          "## Facts",
          "",
          "- likes tea",
        ].join("\n"),
      },
    });
  });

  it("creates a missing page through write_section with a simple scaffold", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{message: "Page not found"}],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            create: {
              responseResult: {
                succeeded: true,
                message: "created",
              },
              page: {id: 14},
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 14,
              updatedAt: "2026-04-19T10:07:00.000Z",
              content: [
                "# Profile",
                "",
                "## Facts",
                "",
                "- likes tea",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "write_section",
      path: "agents/panda/profile",
      title: "Profile",
      section: "Facts",
      content: "- likes tea",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "write_section",
      action: "created",
      section: {
        title: "Facts",
        action: "created",
      },
    });
    expect(getRequestBody(fetchImpl, 1)).toMatchObject({
      variables: {
        content: [
          "# Profile",
          "",
          "## Facts",
          "",
          "- likes tea",
        ].join("\n"),
      },
    });
  });

  it("rejects conflict-aware section writes when the page changed since baseUpdatedAt", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 12,
              content: [
                "# Profile",
                "",
                "## Facts",
                "",
                "Old facts.",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            checkConflicts: true,
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            conflictLatest: {
              id: 12,
              path: "agents/panda/profile",
              locale: "en",
              title: "Profile",
              description: "Latest profile page.",
              content: "# Panda v2",
              isPublished: true,
              tags: ["profile"],
              updatedAt: "2026-04-19T10:05:00.000Z",
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    await expect(tool.run({
      operation: "write_section",
      path: "agents/panda/profile",
      section: "Facts",
      content: "New facts.",
      baseUpdatedAt: "2026-04-19T10:00:00.000Z",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }))).rejects.toEqual(expect.objectContaining({
      message: expect.stringContaining("changed since 2026-04-19T10:00:00.000Z"),
    }));
  });

  it("archives a page by moving it under the namespace archive tree", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T10:10:00.000Z"));
    try {
      const bindings = createBindings();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: {
            pages: {
              singleByPath: buildPage({
                id: 21,
                path: "agents/panda/profile",
              }),
            },
          },
        }), {
          status: 200,
          headers: {"content-type": "application/json"},
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: {
            pages: {
              move: {
                responseResult: {
                  succeeded: true,
                  message: "moved",
                },
              },
            },
          },
        }), {
          status: 200,
          headers: {"content-type": "application/json"},
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: {
            pages: {
              singleByPath: buildPage({
                id: 21,
                path: "agents/panda/_archive/2026/04/profile-20260419t101000z",
                updatedAt: "2026-04-19T10:10:01.000Z",
              }),
            },
          },
        }), {
          status: 200,
          headers: {"content-type": "application/json"},
        }));

      const tool = new WikiTool({
        env: {
          WIKI_URL: "http://wiki:3000",
        } as NodeJS.ProcessEnv,
        fetchImpl: fetchImpl as typeof fetch,
        bindings,
      });

      const result = await tool.run({
        operation: "archive",
        path: "agents/panda/profile",
      }, createRunContext({
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
      })) as ToolResultPayload;

      expect(parseToolResult(result)).toMatchObject({
        operation: "archive",
        archivedFrom: "agents/panda/profile",
        archivedTo: "agents/panda/_archive/2026/04/profile-20260419t101000z",
      });
      expect(getRequestBody(fetchImpl, 1)).toMatchObject({
        variables: {
          id: 21,
          destinationPath: "agents/panda/_archive/2026/04/profile-20260419t101000z",
          destinationLocale: "en",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a page and rewrites inbound plus relative internal links by default", async () => {
    const bindings = createBindings();
    const pages = new Map<string, Record<string, unknown>>([
      ["en/agents/panda/notes/today", buildPage({
        id: 31,
        path: "agents/panda/notes/today",
        title: "Today",
        content: [
          "# Today",
          "",
          "[Profile](../profile)",
        ].join("\n"),
      })],
      ["en/agents/panda/index", buildPage({
        id: 32,
        path: "agents/panda/index",
        title: "Index",
        content: [
          "# Index",
          "",
          "[Today](notes/today)",
        ].join("\n"),
      })],
      ["en/agents/panda/_archive/2026/04/old-index", buildPage({
        id: 33,
        path: "agents/panda/_archive/2026/04/old-index",
        title: "Archived Index",
        content: [
          "# Archived",
          "",
          "[Today](/agents/panda/notes/today)",
        ].join("\n"),
      })],
    ]);
    const updateCalls: Array<{content: string; path: string}> = [];
    let updatedAtCounter = 20;

    const jsonResponse = (body: Record<string, unknown>) => new Response(JSON.stringify(body), {
      status: 200,
      headers: {"content-type": "application/json"},
    });

    const nextUpdatedAt = () => `2026-04-19T10:${String(updatedAtCounter += 1).padStart(2, "0")}:00.000Z`;

    const findPageById = (id: number): {key: string; page: Record<string, unknown>} | null => {
      for (const [key, page] of pages.entries()) {
        const pageId = typeof page.id === "number" ? page.id : Number(page.id);
        if (pageId === id) {
          return {key, page};
        }
      }
      return null;
    };

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = String(requestBody.query ?? "");
      const variables = requestBody.variables ?? {};

      if (query.includes("singleByPath")) {
        const key = `${String(variables.locale ?? "en")}/${String(variables.path ?? "").replace(/^\/+|\/+$/g, "")}`;
        const page = pages.get(key);
        return page
          ? jsonResponse({data: {pages: {singleByPath: page}}})
          : jsonResponse({errors: [{message: "Page not found"}]});
      }

      if (query.includes("move(")) {
        const pageRecord = findPageById(Number(variables.id));
        if (!pageRecord) {
          return jsonResponse({data: {pages: {move: {responseResult: {succeeded: false, message: "missing"}}}}});
        }

        pages.delete(pageRecord.key);
        const moved = {
          ...pageRecord.page,
          locale: String(variables.destinationLocale ?? "en"),
          path: String(variables.destinationPath ?? ""),
          updatedAt: nextUpdatedAt(),
        };
        pages.set(`${moved.locale}/${moved.path}`, moved);

        return jsonResponse({
          data: {
            pages: {
              move: {
                responseResult: {
                  succeeded: true,
                  message: "moved",
                },
              },
            },
          },
        });
      }

      if (query.includes("links(locale")) {
        return jsonResponse({
          data: {
            pages: {
              links: [
                {
                  id: 32,
                  path: "en/agents/panda/index",
                  title: "Index",
                  links: ["en/agents/panda/notes/today"],
                },
                {
                  id: 33,
                  path: "en/agents/panda/_archive/2026/04/old-index",
                  title: "Archived Index",
                  links: ["en/agents/panda/notes/today"],
                },
              ],
            },
          },
        });
      }

      if (query.includes("update(")) {
        const pageRecord = findPageById(Number(variables.id));
        if (!pageRecord) {
          return jsonResponse({data: {pages: {update: {responseResult: {succeeded: false, message: "missing"}, page: null}}}});
        }

        pages.delete(pageRecord.key);
        const updated = {
          ...pageRecord.page,
          locale: String(variables.locale ?? "en"),
          path: String(variables.path ?? ""),
          title: String(variables.title ?? ""),
          description: String(variables.description ?? ""),
          content: String(variables.content ?? ""),
          editor: String(variables.editor ?? "markdown"),
          isPublished: variables.isPublished === true,
          isPrivate: variables.isPrivate === true,
          tags: Array.isArray(variables.tags)
            ? variables.tags.map((tag) => ({tag}))
            : [],
          updatedAt: nextUpdatedAt(),
        };
        pages.set(`${updated.locale}/${updated.path}`, updated);
        updateCalls.push({
          path: updated.path,
          content: updated.content,
        });

        return jsonResponse({
          data: {
            pages: {
              update: {
                responseResult: {
                  succeeded: true,
                  message: "updated",
                },
                page: {id: updated.id},
              },
            },
          },
        });
      }

      if (query.includes("checkConflicts")) {
        return jsonResponse({data: {pages: {checkConflicts: false}}});
      }

      throw new Error(`Unexpected wiki GraphQL query: ${query}`);
    });

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    const result = await tool.run({
      operation: "move",
      path: "agents/panda/notes/today",
      destinationPath: "agents/panda/journal/2026/today",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      operation: "move",
      movedFrom: "agents/panda/notes/today",
      movedTo: "agents/panda/journal/2026/today",
      rewriteLinks: true,
      linkRewrite: {
        rewrittenLinks: 2,
        updatedPages: [
          expect.objectContaining({path: "agents/panda/journal/2026/today", rewrittenLinks: 1}),
          expect.objectContaining({path: "agents/panda/index", rewrittenLinks: 1}),
        ],
        failedPages: [],
      },
    });

    expect(updateCalls).toEqual([
      {
        path: "agents/panda/journal/2026/today",
        content: [
          "# Today",
          "",
          "[Profile](../../profile)",
        ].join("\n"),
      },
      {
        path: "agents/panda/index",
        content: [
          "# Index",
          "",
          "[Today](journal/2026/today)",
        ].join("\n"),
      },
    ]);

    expect(pages.get("en/agents/panda/journal/2026/today")).toBeTruthy();
    expect(pages.get("en/agents/panda/notes/today")).toBeUndefined();
    expect(String(pages.get("en/agents/panda/_archive/2026/04/old-index")?.content ?? "")).toContain(
      "[Today](/agents/panda/notes/today)",
    );
  });

  it("rejects archiving a page that is already archived", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 22,
              path: "agents/panda/_archive/2026/04/profile-20260419t101000z",
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    await expect(tool.run({
      operation: "archive",
      path: "agents/panda/_archive/2026/04/profile-20260419t101000z",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }))).rejects.toThrow(/already archived/);
  });

  it("rejects paths outside the stored namespace before hitting Wiki.js", async () => {
    const bindings = createBindings();
    const fetchImpl = vi.fn();

    const tool = new WikiTool({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });

    await expect(tool.run({
      operation: "get",
      path: "agents/luna/profile",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }))).rejects.toMatchObject({
      message: "Wiki path agents/luna/profile is outside the agent namespace agents/panda. Use only agents/panda or its children, for example agents/panda/profile.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
