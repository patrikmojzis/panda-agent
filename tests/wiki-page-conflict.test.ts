import {describe, expect, it, vi} from "vitest";

import {CommandConflictError} from "../src/domain/commands/errors.js";
import type {WikiPage} from "../src/integrations/wiki/client.js";
import {assertWikiPageVersionCurrent} from "../src/integrations/wiki/page-conflict.js";

function page(path: string, updatedAt: string): WikiPage {
  return {
    id: 12,
    path,
    locale: "en",
    title: "PRIVATE LATEST TITLE",
    description: "Private description.",
    content: "PRIVATE LATEST CONTENT",
    tags: ["profile"],
    editor: "markdown",
    isPublished: true,
    isPrivate: false,
    createdAt: "2026-07-18T18:00:00.000Z",
    updatedAt,
  };
}

describe("Wiki page conflict contract", () => {
  it("shell-quotes the scoped refresh path and omits latest page content", async () => {
    const current = page("agents/panda/profile", "2026-07-18T19:00:00.000Z");
    const latest = page("agents/panda/owner's profile", "2026-07-18T20:00:00.000Z");
    const error = await assertWikiPageVersionCurrent({
      client: {
        checkPageConflicts: vi.fn(async () => true),
        getConflictLatest: vi.fn(async () => latest),
      },
      page: current,
      baseUpdatedAt: current.updatedAt,
      namespacePath: "agents/panda",
      requestedPath: current.path,
    }).then(() => null, (reason: unknown) => reason as CommandConflictError);

    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error?.toCommandError()).toMatchObject({
      code: "conflict",
      details: {
        resource: {
          path: "agents/panda/owner's profile",
          latestUpdatedAt: latest.updatedAt,
        },
        nextAction: {
          kind: "refresh_merge_write",
          command: "panda wiki read 'agents/panda/owner'\"'\"'s profile'",
        },
      },
    });
    expect(JSON.stringify(error?.toCommandError())).not.toContain(latest.title);
    expect(JSON.stringify(error?.toCommandError())).not.toContain(latest.content);
  });

  it("falls back to the requested scoped path when the latest path moved outside the namespace", async () => {
    const current = page("agents/panda/profile", "2026-07-18T19:00:00.000Z");
    const latest = page("agents/other/private", "2026-07-18T20:00:00.000Z");
    const error = await assertWikiPageVersionCurrent({
      client: {
        checkPageConflicts: vi.fn(async () => true),
        getConflictLatest: vi.fn(async () => latest),
      },
      page: current,
      baseUpdatedAt: current.updatedAt,
      namespacePath: "agents/panda",
      requestedPath: current.path,
    }).then(() => null, (reason: unknown) => reason as CommandConflictError);

    expect(error?.toCommandError()).toMatchObject({
      details: {
        resource: {path: current.path},
        nextAction: {command: `panda wiki read ${current.path}`},
      },
    });
    expect(JSON.stringify(error?.toCommandError())).not.toContain(latest.path);
  });

  it("includes a non-default locale in the canonical refresh command", async () => {
    const current = page("agents/panda/profile", "2026-07-18T19:00:00.000Z");
    const latest = {...page(current.path, "2026-07-18T20:00:00.000Z"), locale: "sk"};
    const error = await assertWikiPageVersionCurrent({
      client: {
        checkPageConflicts: vi.fn(async () => true),
        getConflictLatest: vi.fn(async () => latest),
      },
      page: current,
      baseUpdatedAt: current.updatedAt,
      namespacePath: "agents/panda",
      requestedPath: current.path,
    }).then(() => null, (reason: unknown) => reason as CommandConflictError);

    expect(error?.toCommandError()).toMatchObject({
      details: {
        resource: {locale: "sk"},
        nextAction: {command: `panda wiki read ${current.path} --locale sk`},
      },
    });
  });
});
