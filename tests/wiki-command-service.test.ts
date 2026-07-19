import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import type {JsonObject} from "../src/lib/json.js";
import type {CommandName, RegisteredCommand} from "../src/domain/commands/types.js";
import {
  createWikiArchiveCommand,
  createWikiAttachImageCommand,
  createWikiDeleteAssetCommand,
  createWikiDiffCommand,
  createWikiFetchAssetCommand,
  createWikiMoveCommand,
  createWikiReadCommand,
  createWikiSearchCommand,
  createWikiRestoreCommand,
  createWikiWriteCommand,
  createWikiWriteSectionCommand,
  WIKI_ARCHIVE_COMMAND_NAME,
  WIKI_ATTACH_IMAGE_COMMAND_NAME,
  WIKI_DELETE_ASSET_COMMAND_NAME,
  WIKI_DIFF_COMMAND_NAME,
  WIKI_FETCH_ASSET_COMMAND_NAME,
  WIKI_MOVE_COMMAND_NAME,
  WIKI_READ_COMMAND_NAME,
  WIKI_SEARCH_COMMAND_NAME,
  WIKI_RESTORE_COMMAND_NAME,
  WIKI_WRITE_COMMAND_NAME,
  WIKI_WRITE_SECTION_COMMAND_NAME,
} from "../src/domain/wiki/commands.js";
import {WikiRuntimeCommandService} from "../src/integrations/wiki/command-service.js";

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
    id: 12,
    path: "agents/panda/profile",
    locale: "en",
    title: "Profile",
    description: "Profile page.",
    content: "# Profile",
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

function wikiGraphQlResponse(pages: Record<string, unknown>): Response {
  return new Response(JSON.stringify({data: {pages}}), {
    status: 200,
    headers: {"content-type": "application/json"},
  });
}

function createStaleWikiFetch(pagePath: string) {
  const operations: string[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected Wiki GraphQL request body.");
    const body = JSON.parse(init.body) as {query?: unknown; variables?: Record<string, unknown>};
    const query = typeof body.query === "string" ? body.query : "";
    if (query.includes("GetPageByPath")) {
      operations.push("read");
      return wikiGraphQlResponse({
        singleByPath: body.variables?.path === pagePath
          ? buildPage({path: pagePath, updatedAt: "2026-07-18T19:00:00.000Z"})
          : null,
      });
    }
    if (query.includes("CheckPageConflicts")) {
      operations.push("check_conflict");
      return wikiGraphQlResponse({checkConflicts: true});
    }
    if (query.includes("GetConflictLatest")) {
      operations.push("read_latest_revision");
      return wikiGraphQlResponse({
        conflictLatest: buildPage({
          path: pagePath,
          title: "PRIVATE LATEST TITLE",
          content: "PRIVATE LATEST CONTENT",
          updatedAt: "2026-07-18T20:00:00.000Z",
        }),
      });
    }
    throw new Error(`Unexpected Wiki operation after stale conflict: ${query.slice(0, 80)}`);
  });
  return {fetchImpl, operations};
}

interface StaleWikiCommandCase {
  label: string;
  commandName: CommandName;
  pagePath: string;
  input: JsonObject;
  createCommand(service: WikiRuntimeCommandService): RegisteredCommand;
}

const STALE_WIKI_COMMAND_CASES: readonly StaleWikiCommandCase[] = [
  {
    label: "page replacement",
    commandName: WIKI_WRITE_COMMAND_NAME,
    pagePath: "agents/panda/profile",
    input: {
      path: "agents/panda/profile",
      content: "# Merged profile",
      baseUpdatedAt: "2026-07-18T19:00:00.000Z",
    },
    createCommand: createWikiWriteCommand,
  },
  {
    label: "section update",
    commandName: WIKI_WRITE_SECTION_COMMAND_NAME,
    pagePath: "agents/panda/profile",
    input: {
      path: "agents/panda/profile",
      section: "Facts",
      content: "New facts.",
      baseUpdatedAt: "2026-07-18T19:00:00.000Z",
    },
    createCommand: createWikiWriteSectionCommand,
  },
  {
    label: "move",
    commandName: WIKI_MOVE_COMMAND_NAME,
    pagePath: "agents/panda/profile",
    input: {
      path: "agents/panda/profile",
      destinationPath: "agents/panda/about",
      baseUpdatedAt: "2026-07-18T19:00:00.000Z",
    },
    createCommand: createWikiMoveCommand,
  },
  {
    label: "archive",
    commandName: WIKI_ARCHIVE_COMMAND_NAME,
    pagePath: "agents/panda/profile",
    input: {
      path: "agents/panda/profile",
      baseUpdatedAt: "2026-07-18T19:00:00.000Z",
    },
    createCommand: createWikiArchiveCommand,
  },
  {
    label: "restore",
    commandName: WIKI_RESTORE_COMMAND_NAME,
    pagePath: "agents/panda/_archive/2026/07/profile-old",
    input: {
      path: "agents/panda/_archive/2026/07/profile-old",
      destinationPath: "agents/panda/profile",
      baseUpdatedAt: "2026-07-18T19:00:00.000Z",
    },
    createCommand: createWikiRestoreCommand,
  },
  {
    label: "image attachment",
    commandName: WIKI_ATTACH_IMAGE_COMMAND_NAME,
    pagePath: "agents/panda/profile",
    input: {
      path: "agents/panda/profile",
      section: "Facts",
      slot: "profile-photo",
      sourcePath: "private-source.png",
      alt: "Profile photo",
      baseUpdatedAt: "2026-07-18T19:00:00.000Z",
    },
    createCommand: (service) => createWikiAttachImageCommand(service, {
      async resolveReadablePath({file}) {
        return {path: `/nonexistent/${file.path}`, displayPath: file.path};
      },
    }),
  },
];

describe("wiki command service", () => {
  it("limits scoped wiki.search results and reports truncation", async () => {
    const bindings = createBindings();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        pages: {
          search: {
            results: [
              {
                id: "1",
                path: "agents/panda/profile",
                locale: "en",
                title: "Profile",
                description: "Profile page.",
              },
              {
                id: "2",
                path: "agents/panda/notes/day",
                locale: "en",
                title: "Day notes",
                description: "Notes.",
              },
              {
                id: "3",
                path: "agents/other/profile",
                locale: "en",
                title: "Other",
                description: "Out of scope.",
              },
            ],
            suggestions: ["profiles"],
            totalHits: 3,
          },
        },
      },
    }), {
      status: 200,
      headers: {"content-type": "application/json"},
    }));
    const service = new WikiRuntimeCommandService({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });
    const command = createWikiSearchCommand(service);

    const result = await command.execute({
      command: WIKI_SEARCH_COMMAND_NAME,
      input: {
        query: "profile",
        limit: 1,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      operation: "search",
      query: "profile",
      path: "agents/panda",
      totalHits: 2,
      count: 1,
      truncated: true,
      suggestions: ["profiles"],
      results: [
        expect.objectContaining({path: "agents/panda/profile"}),
      ],
    });
    expect(getRequestBody(fetchImpl, 0)).toMatchObject({
      variables: {
        query: "profile",
        locale: "en",
      },
    });
  });

  it("rejects an out-of-namespace path as a terminal denial before Wiki I/O", async () => {
    const fetchImpl = vi.fn();
    const service = new WikiRuntimeCommandService({
      env: {WIKI_URL: "http://wiki:3000"} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings: createBindings(),
    });
    const command = createWikiSearchCommand(service);

    await expect(command.execute({
      command: WIKI_SEARCH_COMMAND_NAME,
      input: {query: "private", path: "agents/other/private"},
      scope: {agentKey: "panda", sessionId: "session-1"},
    })).rejects.toMatchObject({
      pandaCommandErrorCode: "forbidden",
      pandaCommandErrorDetails: {
        failureCode: "resource_scope_denied",
        retryable: false,
        nextAction: {
          kind: "stop",
          reason: "Use only paths returned by Wiki commands in the current agent namespace.",
        },
        exitCode: 3,
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(STALE_WIKI_COMMAND_CASES)("returns a safe terminal conflict for stale $label", async (testCase) => {
    const {fetchImpl, operations} = createStaleWikiFetch(testCase.pagePath);
    const service = new WikiRuntimeCommandService({
      env: {WIKI_URL: "http://wiki:3000"} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings: createBindings(),
    });
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [testCase.createCommand(service)],
    });

    const result = await dispatcher.execute({
      command: testCase.commandName,
      input: testCase.input,
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
        allowedCommands: [testCase.commandName],
      },
    });

    expect(result).toEqual({
      ok: false,
      command: testCase.commandName,
      error: {
        code: "conflict",
        message: "The Wiki page changed after the supplied baseUpdatedAt.",
        details: {
          failureCode: "stale_version",
          retryable: false,
          requiresRefresh: true,
          resource: {
            kind: "wiki_page",
            path: testCase.pagePath,
            locale: "en",
            latestUpdatedAt: "2026-07-18T20:00:00.000Z",
          },
          nextAction: {
            kind: "refresh_merge_write",
            command: `panda wiki read ${testCase.pagePath}`,
          },
          exitCode: 4,
        },
      },
    });
    expect(operations).toEqual(["read", "check_conflict", "read_latest_revision"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE LATEST TITLE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE LATEST CONTENT");
    expect(JSON.stringify(result)).not.toContain("# Merged profile");
  });

  it("recovers through explicit read -> merge -> fresh write without repeating the stale write", async () => {
    const operations: string[] = [];
    let conflictChecks = 0;
    let updates = 0;
    const latestUpdatedAt = "2026-07-18T20:00:00.000Z";
    const updatedAt = "2026-07-18T20:05:00.000Z";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected Wiki GraphQL request body.");
      const body = JSON.parse(init.body) as {query?: unknown; variables?: Record<string, unknown>};
      const query = typeof body.query === "string" ? body.query : "";
      if (query.includes("GetPageByPath")) {
        operations.push("read");
        return wikiGraphQlResponse({
          singleByPath: buildPage({
            content: updates === 0 ? "# Profile\n\nLatest fact." : "# Profile\n\nLatest fact.\n\nMerged intent.",
            updatedAt: updates === 0 ? latestUpdatedAt : updatedAt,
          }),
        });
      }
      if (query.includes("CheckPageConflicts")) {
        conflictChecks += 1;
        operations.push(conflictChecks === 1 ? "check_stale" : "check_fresh");
        return wikiGraphQlResponse({checkConflicts: conflictChecks === 1});
      }
      if (query.includes("GetConflictLatest")) {
        operations.push("read_latest_revision");
        return wikiGraphQlResponse({
          conflictLatest: buildPage({
            content: "PRIVATE LATEST CONTENT",
            updatedAt: latestUpdatedAt,
          }),
        });
      }
      if (query.includes("UpdatePage")) {
        operations.push("write_merged");
        expect(body.variables).toMatchObject({
          content: "# Profile\n\nLatest fact.\n\nMerged intent.",
        });
        updates += 1;
        return wikiGraphQlResponse({
          update: {
            responseResult: {succeeded: true, message: "updated"},
            page: {id: 12},
          },
        });
      }
      throw new Error(`Unexpected Wiki operation: ${query.slice(0, 80)}`);
    });
    const service = new WikiRuntimeCommandService({
      env: {WIKI_URL: "http://wiki:3000"} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings: createBindings(),
    });
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createWikiWriteCommand(service), createWikiReadCommand(service)],
    });
    const scope = {
      agentKey: "panda",
      sessionId: "session-1",
      allowedCommands: [WIKI_WRITE_COMMAND_NAME, WIKI_READ_COMMAND_NAME],
    };

    const stale = await dispatcher.execute({
      command: WIKI_WRITE_COMMAND_NAME,
      input: {
        path: "agents/panda/profile",
        content: "# Profile\n\nStale intent.",
        baseUpdatedAt: "2026-07-18T19:00:00.000Z",
      },
      scope,
    });
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: {
          retryable: false,
          nextAction: {
            kind: "refresh_merge_write",
            command: "panda wiki read agents/panda/profile",
          },
        },
      },
    });
    expect(updates).toBe(0);
    expect(operations).toEqual(["read", "check_stale", "read_latest_revision"]);

    const refreshed = await dispatcher.execute({
      command: WIKI_READ_COMMAND_NAME,
      input: {path: "agents/panda/profile"},
      scope,
    });
    expect(refreshed).toMatchObject({
      ok: true,
      output: {
        content: "# Profile\n\nLatest fact.",
        updatedAt: latestUpdatedAt,
      },
    });

    const merged = await dispatcher.execute({
      command: WIKI_WRITE_COMMAND_NAME,
      input: {
        path: "agents/panda/profile",
        content: "# Profile\n\nLatest fact.\n\nMerged intent.",
        baseUpdatedAt: latestUpdatedAt,
      },
      scope,
    });
    expect(merged).toMatchObject({
      ok: true,
      output: {
        action: "updated",
        page: {updatedAt},
      },
    });
    expect(operations).toEqual([
      "read",
      "check_stale",
      "read_latest_revision",
      "read",
      "read",
      "check_fresh",
      "write_merged",
      "read",
    ]);
    expect(conflictChecks).toBe(2);
    expect(updates).toBe(1);
  });

  it("diffs two namespace-scoped wiki pages", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 41,
              path: "agents/panda/_archive/2026/06/profile-old",
              title: "Old profile",
              content: [
                "# Profile",
                "",
                "Old fact.",
              ].join("\n"),
              updatedAt: "2026-06-25T11:00:00.000Z",
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
            singleByPath: buildPage({
              id: 42,
              path: "agents/panda/profile",
              title: "Profile",
              content: [
                "# Profile",
                "",
                "New fact.",
              ].join("\n"),
              updatedAt: "2026-06-25T12:00:00.000Z",
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));
    const service = new WikiRuntimeCommandService({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });
    const command = createWikiDiffCommand(service);

    const result = await command.execute({
      command: WIKI_DIFF_COMMAND_NAME,
      input: {
        leftPath: "agents/panda/_archive/2026/06/profile-old",
        rightPath: "agents/panda/profile",
        contextLines: 1,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      operation: "diff",
      locale: "en",
      left: {
        path: "agents/panda/_archive/2026/06/profile-old",
        contentLines: 3,
      },
      right: {
        path: "agents/panda/profile",
        contentLines: 3,
      },
      equal: false,
      contextLines: 1,
      stats: {
        addedLines: 1,
        removedLines: 1,
        unchangedLines: 2,
        leftLines: 3,
        rightLines: 3,
      },
      hunks: [
        expect.objectContaining({
          oldStart: 2,
          newStart: 2,
          lines: [
            expect.objectContaining({type: "context", text: ""}),
            expect.objectContaining({type: "remove", text: "Old fact."}),
            expect.objectContaining({type: "add", text: "New fact."}),
          ],
        }),
      ],
      truncated: false,
    });
    expect(getRequestBody(fetchImpl, 0)).toMatchObject({
      variables: {
        path: "agents/panda/_archive/2026/06/profile-old",
        locale: "en",
      },
    });
    expect(getRequestBody(fetchImpl, 1)).toMatchObject({
      variables: {
        path: "agents/panda/profile",
        locale: "en",
      },
    });
  });

  it("executes wiki.write.section through the Wiki.js service", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
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
              updatedAt: "2026-04-19T10:05:00.000Z",
              content: [
                "# Profile",
                "",
                "## Facts",
                "",
                "New facts.",
              ].join("\n"),
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));
    const service = new WikiRuntimeCommandService({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });
    const command = createWikiWriteSectionCommand(service);

    const result = await command.execute({
      command: WIKI_WRITE_SECTION_COMMAND_NAME,
      input: {
        path: "agents/panda/profile",
        section: "Facts",
        content: "New facts.",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      operation: "write_section",
      action: "updated",
      section: {
        title: "Facts",
        action: "replaced",
      },
      page: {
        path: "agents/panda/profile",
        locale: "en",
        title: "Profile",
        updatedAt: "2026-04-19T10:05:00.000Z",
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
        ].join("\n"),
      },
    });
  });

  it("executes wiki.restore through the Wiki.js service", async () => {
    const bindings = createBindings();
    const archivedPath = "agents/panda/_archive/2026/06/profile-20260625t120000z";
    const destinationPath = "agents/panda/profile";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: buildPage({
              id: 44,
              path: archivedPath,
              updatedAt: "2026-06-25T12:00:00.000Z",
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
            singleByPath: null,
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
              id: 44,
              path: destinationPath,
              updatedAt: "2026-06-25T12:05:00.000Z",
            }),
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));
    const service = new WikiRuntimeCommandService({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });
    const command = createWikiRestoreCommand(service);

    const result = await command.execute({
      command: WIKI_RESTORE_COMMAND_NAME,
      input: {
        path: archivedPath,
        destinationPath,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      operation: "restore",
      restoredFrom: archivedPath,
      restoredTo: destinationPath,
      page: {
        id: 44,
        path: destinationPath,
        locale: "en",
        title: "Profile",
        updatedAt: "2026-06-25T12:05:00.000Z",
      },
    });
    expect(getRequestBody(fetchImpl, 2)).toMatchObject({
      variables: {
        id: 44,
        destinationPath,
        destinationLocale: "en",
      },
    });
  });

  it("executes wiki.attach.image through the Wiki.js service", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-wiki-command-attach-"));
    try {
      const sourcePath = path.join(tempDir, "profile.png");
      await writeFile(sourcePath, Buffer.from("fake-image", "utf8"));
      const bindings = createBindings();
      const uploads: Array<{folderId: number; filename: string; bytes: string}> = [];
      let rootFolders: Array<{id: number; slug: string; name: string}> = [];
      let savedContent: string | null = null;

      const jsonResponse = (body: Record<string, unknown>) => new Response(JSON.stringify(body), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/u")) {
          const form = init?.body as FormData;
          const parts = form.getAll("mediaUpload");
          const metadata = JSON.parse(String(parts[0])) as {folderId: number};
          uploads.push({
            folderId: metadata.folderId,
            filename: (parts[1] as File).name,
            bytes: await (parts[1] as File).text(),
          });
          return new Response("ok", {
            status: 200,
            headers: {"content-type": "text/plain"},
          });
        }

        const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
          query?: string;
          variables?: Record<string, unknown>;
        };
        const query = String(requestBody.query ?? "");
        const variables = requestBody.variables ?? {};

        if (query.includes("singleByPath")) {
          return jsonResponse({
            data: {
              pages: {
                singleByPath: buildPage({
                  id: 44,
                  updatedAt: savedContent ? "2026-04-19T10:09:00.000Z" : "2026-04-19T10:01:00.000Z",
                  content: savedContent ?? [
                    "# Profile",
                    "",
                    "## Facts",
                    "",
                    "Old facts.",
                  ].join("\n"),
                }),
              },
            },
          });
        }

        if (query.includes("folders(parentFolderId")) {
          return jsonResponse({
            data: {
              assets: {
                folders: Number(variables.parentFolderId) === 0 ? rootFolders : [],
              },
            },
          });
        }

        if (query.includes("createFolder(")) {
          const slug = String(variables.slug ?? "");
          rootFolders = [{
            id: 30,
            slug,
            name: slug,
          }];
          return jsonResponse({
            data: {
              assets: {
                createFolder: {
                  responseResult: {
                    succeeded: true,
                    message: "created",
                  },
                },
              },
            },
          });
        }

        if (query.includes("update(")) {
          savedContent = String(variables.content ?? "");
          return jsonResponse({
            data: {
              pages: {
                update: {
                  responseResult: {
                    succeeded: true,
                    message: "updated",
                  },
                  page: {id: 44},
                },
              },
            },
          });
        }

        throw new Error(`Unexpected wiki GraphQL query: ${query}`);
      });
      const service = new WikiRuntimeCommandService({
        env: {
          WIKI_URL: "http://wiki:3000",
        } as NodeJS.ProcessEnv,
        fetchImpl: fetchImpl as typeof fetch,
        bindings,
      });
      const command = createWikiAttachImageCommand(service, {
        async resolveReadablePath({file}) {
          return {
            path: sourcePath,
            displayPath: file.path,
          };
        },
      });

      const result = await command.execute({
        command: WIKI_ATTACH_IMAGE_COMMAND_NAME,
        input: {
          path: "agents/panda/profile",
          section: "Facts",
          slot: "profile-photo",
          sourcePath: "profile.png",
          alt: "Profile photo",
        },
        scope: {
          agentKey: "panda",
          sessionId: "session-1",
        },
      });

      expect(result.output).toMatchObject({
        operation: "attach_image",
        action: "updated",
        assetPath: "agents/panda/_assets/profile/profile-photo.png",
        slot: "profile-photo",
        page: {
          path: "agents/panda/profile",
        },
      });
      expect(uploads).toEqual([{
        folderId: 30,
        filename: "profile-photo.png",
        bytes: "fake-image",
      }]);
      expect(savedContent).toContain("agents/panda/_assets/profile/profile-photo.png");
      expect(savedContent).toContain('<!-- panda:asset slot="profile-photo"');
    } finally {
      await rm(tempDir, {recursive: true, force: true});
    }
  });

  it("executes wiki.fetch.asset through the Wiki.js service with an artifact result", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-wiki-command-fetch-"));
    try {
      const bindings = createBindings();
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("http://wiki:3000/agents/panda/_assets/profile/profile-photo.png");
        return new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        });
      });
      const service = new WikiRuntimeCommandService({
        env: {
          WIKI_URL: "http://wiki:3000",
          DATA_DIR: tempDir,
        } as NodeJS.ProcessEnv,
        fetchImpl: fetchImpl as typeof fetch,
        bindings,
      });
      const command = createWikiFetchAssetCommand(service);

      const result = await command.execute({
        command: WIKI_FETCH_ASSET_COMMAND_NAME,
        input: {
          assetPath: "agents/panda/_assets/profile/profile-photo.png",
        },
        scope: {
          agentKey: "panda",
          sessionId: "session-1",
        },
      });

      const localPath = path.join(
        tempDir,
        "agents",
        "panda",
        "media",
        "wiki",
        "fetched",
        "agents",
        "panda",
        "_assets",
        "profile",
        "profile-photo.png",
      );
      expect(result.output).toMatchObject({
        operation: "fetch_asset",
        assetPath: "agents/panda/_assets/profile/profile-photo.png",
        localPath,
        mimeType: "image/png",
        sizeBytes: 3,
      });
      expect(result.artifact).toMatchObject({
        kind: "image",
        source: "view_media",
        path: localPath,
        mimeType: "image/png",
        bytes: 3,
        originalPath: "agents/panda/_assets/profile/profile-photo.png",
      });
      await expect(readFile(localPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await rm(tempDir, {recursive: true, force: true});
    }
  });

  it("executes wiki.delete.asset through the Wiki.js service", async () => {
    const bindings = createBindings();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          assets: {
            folders: [{
              id: 30,
              slug: "profile",
              name: "profile",
            }],
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          assets: {
            list: [{
              id: 44,
              filename: "profile-photo.png",
              ext: "png",
              kind: "IMAGE",
              fileSize: 3,
            }],
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          assets: {
            deleteAsset: {
              responseResult: {
                succeeded: true,
                message: "deleted",
              },
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));
    const service = new WikiRuntimeCommandService({
      env: {
        WIKI_URL: "http://wiki:3000",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as typeof fetch,
      bindings,
    });
    const command = createWikiDeleteAssetCommand(service);

    const result = await command.execute({
      command: WIKI_DELETE_ASSET_COMMAND_NAME,
      input: {
        assetPath: "agents/panda/_assets/profile/profile-photo.png",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toEqual({
      operation: "delete_asset",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      assetId: 44,
      filename: "profile-photo.png",
      deleted: true,
    });
    expect(getRequestBody(fetchImpl, 1)).toMatchObject({
      variables: {
        folderId: 30,
        kind: "ALL",
      },
    });
    expect(getRequestBody(fetchImpl, 2)).toMatchObject({
      variables: {
        id: 44,
      },
    });
  });
});
