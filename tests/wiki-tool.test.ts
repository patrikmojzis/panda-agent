import {describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext, type ToolResultPayload,} from "../src/index.js";
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
      message: "Wiki path agents/luna/profile is outside the agent namespace agents/panda.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
