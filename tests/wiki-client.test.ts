import {describe, expect, it, vi} from "vitest";

import {DEFAULT_WIKI_URL, resolveWikiUrl, WikiJsClient,} from "../src/integrations/wiki/client.js";
import {ToolError} from "../src/kernel/agent/exceptions.js";

describe("WikiJsClient", () => {
  it("uses WIKI_URL when configured and falls back to the docker service url", () => {
    expect(resolveWikiUrl({WIKI_URL: "http://wiki.internal:3000"} as NodeJS.ProcessEnv)).toBe(
      "http://wiki.internal:3000",
    );
    expect(resolveWikiUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_WIKI_URL);
  });

  it("fetches a page by path and sends bearer auth", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(JSON.stringify({
        data: {
          pages: {
            singleByPath: {
              id: 42,
              path: "agents/panda/profile",
              locale: "en",
              title: "Profile",
              description: "Agent profile.",
              content: "# Panda",
              editor: "markdown",
              isPublished: true,
              isPrivate: false,
              createdAt: "2026-04-19T10:00:00.000Z",
              updatedAt: "2026-04-19T11:00:00.000Z",
              tags: [{tag: "profile"}, {tag: "agent"}],
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });

    const client = new WikiJsClient({
      apiToken: "wiki-token",
      baseUrl: "http://wiki.internal:3000/base",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const page = await client.getPageByPath("/agents/panda/profile/", "en");

    expect(page).toMatchObject({
      id: 42,
      path: "agents/panda/profile",
      locale: "en",
      title: "Profile",
      tags: ["profile", "agent"],
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://wiki.internal:3000/base/graphql");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer wiki-token",
      "content-type": "application/json",
    });
  });

  it("surfaces mutation failures from responseResult", async () => {
    const client = new WikiJsClient({
      apiToken: "wiki-token",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        data: {
          pages: {
            update: {
              responseResult: {
                succeeded: false,
                message: "Page empty content",
              },
              page: null,
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      })) as typeof fetch,
    });

    await expect(client.updatePage({
      id: 7,
      path: "agents/panda/profile",
      locale: "en",
      title: "Profile",
      description: "",
      content: "",
    })).rejects.toEqual(new ToolError("Page empty content"));
  });

  it("moves a page and reloads it from the destination path", async () => {
    const fetchImpl = vi
      .fn()
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
            singleByPath: {
              id: 42,
              path: "agents/panda/_archive/2026/04/profile-20260419t100000z",
              locale: "en",
              title: "Profile",
              description: "Archived profile.",
              content: "# Panda",
              editor: "markdown",
              isPublished: true,
              isPrivate: false,
              createdAt: "2026-04-19T10:00:00.000Z",
              updatedAt: "2026-04-19T11:00:00.000Z",
              tags: [{tag: "profile"}],
            },
          },
        },
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      }));

    const client = new WikiJsClient({
      apiToken: "wiki-token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const page = await client.movePage({
      id: 42,
      destinationPath: "agents/panda/_archive/2026/04/profile-20260419t100000z",
      destinationLocale: "en",
    });

    expect(page.path).toBe("agents/panda/_archive/2026/04/profile-20260419t100000z");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {variables?: Record<string, unknown>};
    expect(body.variables).toMatchObject({
      id: 42,
      destinationPath: "agents/panda/_archive/2026/04/profile-20260419t100000z",
      destinationLocale: "en",
    });
  });

  it("treats real Wiki.js missing-page errors as a null lookup", async () => {
    const client = new WikiJsClient({
      apiToken: "wiki-token",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        errors: [{message: "This page does not exist."}],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      })) as typeof fetch,
    });

    await expect(client.getPageByPath("agents/panda/missing", "en")).resolves.toBeNull();
  });

  it("lists asset folders under a parent folder", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        assets: {
          folders: [
            {id: 12, slug: "profile", name: "profile"},
            {id: 13, slug: "photos", name: "photos"},
          ],
        },
      },
    }), {
      status: 200,
      headers: {"content-type": "application/json"},
    }));

    const client = new WikiJsClient({
      apiToken: "wiki-token",
      baseUrl: "http://wiki.internal:3000/base",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listAssetFolders(7)).resolves.toEqual([
      {id: 12, slug: "profile", name: "profile"},
      {id: 13, slug: "photos", name: "photos"},
    ]);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {variables?: Record<string, unknown>};
    expect(body.variables).toMatchObject({parentFolderId: 7});
  });

  it("uploads an asset through the raw /u endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", {
      status: 200,
      headers: {"content-type": "text/plain"},
    }));

    const client = new WikiJsClient({
      apiToken: "wiki-token",
      baseUrl: "http://wiki.internal:3000/base",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.uploadAsset({
      folderId: 12,
      filename: "profile-photo.png",
      bytes: Buffer.from("fake-image", "utf8"),
      mimeType: "image/png",
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://wiki.internal:3000/base/u");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer wiki-token",
    });

    const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
    const parts = form.getAll("mediaUpload");
    expect(String(parts[0])).toBe(JSON.stringify({folderId: 12}));

    const file = parts[1];
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("profile-photo.png");
    await expect((file as File).text()).resolves.toBe("fake-image");
  });

  it("deletes an asset through the GraphQL API", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
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

    const client = new WikiJsClient({
      apiToken: "wiki-token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.deleteAsset(91);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {variables?: Record<string, unknown>};
    expect(body.variables).toMatchObject({id: 91});
  });

  it("downloads an asset from the wiki base url", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": "3",
      },
    }));

    const client = new WikiJsClient({
      apiToken: "wiki-token",
      baseUrl: "http://wiki.internal:3000/base",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const downloaded = await client.downloadAsset("agents/panda/_assets/profile/profile-photo.png");

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://wiki.internal:3000/base/agents/panda/_assets/profile/profile-photo.png",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer wiki-token",
    });
    expect(downloaded).toMatchObject({
      mimeType: "image/png",
      sizeBytes: 3,
    });
    expect(Buffer.from(downloaded.bytes)).toEqual(Buffer.from([1, 2, 3]));
  });
});
