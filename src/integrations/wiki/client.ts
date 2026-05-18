import {ToolError} from "../../kernel/agent/exceptions.js";
import {stringifyUnknown} from "../../kernel/agent/helpers/stringify.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
    DEFAULT_WIKI_EDITOR,
    DEFAULT_WIKI_LOCALE,
    DEFAULT_WIKI_URL,
} from "./constants.js";
import {
    normalizeWikiLocale,
    normalizeWikiPath,
    normalizeWikiTags,
} from "./client-input.js";
import {
    isMissingPageMessage,
    normalizeContentType,
    normalizeGraphQlErrors,
    parseWikiAssetFolders,
    parseWikiAssetList,
    parseWikiPage,
    parseWikiPageLinks,
    parseWikiPageList,
    parseWikiSearchResults,
    pickInteger,
    pickMessage,
    type GraphQlEnvelope,
    type WikiResponseResult,
} from "./client-parsers.js";
import type {
    WikiAssetDownloadResult,
    WikiAssetFolder,
    WikiAssetListItem,
    WikiAssetUploadInput,
    WikiJsClientOptions,
    WikiPage,
    WikiPageLinkItem,
    WikiPageListItem,
    WikiPageMoveInput,
    WikiPageSearchResult,
    WikiPageWriteInput,
} from "./types.js";

export {
  DEFAULT_WIKI_EDITOR,
  DEFAULT_WIKI_LOCALE,
  DEFAULT_WIKI_URL,
} from "./constants.js";
export type {
  WikiAssetDownloadResult,
  WikiAssetFolder,
  WikiAssetListItem,
  WikiAssetUploadInput,
  WikiJsClientOptions,
  WikiPage,
  WikiPageLinkItem,
  WikiPageListItem,
  WikiPageMoveInput,
  WikiPageSearchResult,
  WikiPageWriteInput,
} from "./types.js";

function buildWikiUrl(baseUrl: string, route: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/g, "");
  const suffix = route.replace(/^\/+/g, "");
  url.pathname = `${basePath}/${suffix}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildGraphQlUrl(baseUrl: string): string {
  return buildWikiUrl(baseUrl, "graphql");
}

function buildUploadUrl(baseUrl: string): string {
  return buildWikiUrl(baseUrl, "u");
}

function buildAssetUrl(baseUrl: string, assetPath: string): string {
  return buildWikiUrl(baseUrl, normalizeWikiPath(assetPath));
}

function formatTransportError(error: unknown): string {
  return stringifyUnknown(error, {preferErrorMessage: true});
}

async function fetchWiki(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    throw new ToolError(`${label} failed before receiving a response: ${formatTransportError(error)}`);
  }
}

export function resolveWikiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimToUndefined(env.WIKI_URL) ?? DEFAULT_WIKI_URL;
}

export class WikiJsClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WikiJsClientOptions) {
    const apiToken = trimToUndefined(options.apiToken);
    if (!apiToken) {
      throw new ToolError("Wiki.js client requires an API token.");
    }

    this.apiToken = apiToken;
    this.baseUrl = trimToUndefined(options.baseUrl) ?? DEFAULT_WIKI_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildAuthHeaders(headers: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiToken}`,
      ...headers,
    };
  }

  private async graphQlRequest<TData>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<TData> {
    const response = await fetchWiki(this.fetchImpl, buildGraphQlUrl(this.baseUrl), {
      method: "POST",
      headers: this.buildAuthHeaders({
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        query,
        variables,
      }),
    }, "Wiki.js request");

    let payload: GraphQlEnvelope<TData> | null = null;
    try {
      payload = await response.json() as GraphQlEnvelope<TData>;
    } catch {
      if (!response.ok) {
        throw new ToolError(`Wiki.js request failed with status ${response.status}.`);
      }
      throw new ToolError("Wiki.js returned invalid JSON.");
    }

    const messages = normalizeGraphQlErrors(payload.errors);
    if (!response.ok) {
      throw new ToolError(
        messages[0] ?? `Wiki.js request failed with status ${response.status}.`,
      );
    }
    if (messages.length > 0) {
      throw new ToolError(messages[0] ?? "Wiki.js returned an error.");
    }
    if (!payload.data) {
      throw new ToolError("Wiki.js response did not include data.");
    }

    return payload.data;
  }

  async getPageByPath(path: string, locale = DEFAULT_WIKI_LOCALE): Promise<WikiPage | null> {
    try {
      const data = await this.graphQlRequest<{
        pages?: {
          singleByPath?: unknown;
        };
      }>(
        `query GetPageByPath($path: String!, $locale: String!) {
          pages {
            singleByPath(path: $path, locale: $locale) {
              id
              path
              locale
              title
              description
              content
              editor
              isPublished
              isPrivate
              createdAt
              updatedAt
              tags {
                tag
              }
            }
          }
        }`,
        {
          path: normalizeWikiPath(path),
          locale: normalizeWikiLocale(locale),
        },
      );
      return data.pages?.singleByPath ? parseWikiPage(data.pages.singleByPath) : null;
    } catch (error) {
      if (error instanceof ToolError && isMissingPageMessage(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async searchPages(
    query: string,
    options: {
      path?: string;
      locale?: string;
    } = {},
  ): Promise<{
    results: WikiPageSearchResult[];
    suggestions: string[];
    totalHits: number;
  }> {
    const data = await this.graphQlRequest<{
      pages?: {
        search?: {
          results?: unknown;
          suggestions?: unknown;
          totalHits?: unknown;
        };
      };
    }>(
      `query SearchPages($query: String!, $path: String, $locale: String) {
        pages {
          search(query: $query, path: $path, locale: $locale) {
            results {
              id
              title
              description
              path
              locale
            }
            suggestions
            totalHits
          }
        }
      }`,
      {
        query: query.trim(),
        path: options.path ? normalizeWikiPath(options.path) : undefined,
        locale: options.locale ? normalizeWikiLocale(options.locale) : undefined,
      },
    );

    const search = data.pages?.search;
    return {
      results: parseWikiSearchResults(search?.results),
      suggestions: Array.isArray(search?.suggestions)
        ? search.suggestions.filter((value): value is string => typeof value === "string")
        : [],
      totalHits: typeof search?.totalHits === "number" ? search.totalHits : 0,
    };
  }

  async listPages(options: {
    limit?: number;
    orderBy?: "ID" | "PATH" | "TITLE" | "CREATED" | "UPDATED";
    orderByDirection?: "ASC" | "DESC";
    locale?: string;
  } = {}): Promise<WikiPageListItem[]> {
    const data = await this.graphQlRequest<{
      pages?: {
        list?: unknown;
      };
    }>(
      `query ListPages(
        $limit: Int
        $locale: String
        $orderBy: PageOrderBy
        $orderByDirection: PageOrderByDirection
      ) {
        pages {
          list(
            limit: $limit
            locale: $locale
            orderBy: $orderBy
            orderByDirection: $orderByDirection
          ) {
            id
            path
            locale
            title
            updatedAt
          }
        }
      }`,
      {
        limit: options.limit,
        locale: options.locale ? normalizeWikiLocale(options.locale) : undefined,
        orderBy: options.orderBy,
        orderByDirection: options.orderByDirection,
      },
    );

    return parseWikiPageList(data.pages?.list);
  }

  async listPageLinks(locale = DEFAULT_WIKI_LOCALE): Promise<WikiPageLinkItem[]> {
    const data = await this.graphQlRequest<{
      pages?: {
        links?: unknown;
      };
    }>(
      `query ListPageLinks($locale: String!) {
        pages {
          links(locale: $locale) {
            id
            title
            path
            links
          }
        }
      }`,
      {
        locale: normalizeWikiLocale(locale),
      },
    );

    return parseWikiPageLinks(data.pages?.links);
  }

  async listAssetFolders(parentFolderId: number | null): Promise<WikiAssetFolder[]> {
    const data = await this.graphQlRequest<{
      assets?: {
        folders?: unknown;
      };
    }>(
      `query ListAssetFolders($parentFolderId: Int!) {
        assets {
          folders(parentFolderId: $parentFolderId) {
            id
            slug
            name
          }
        }
      }`,
      {
        parentFolderId: parentFolderId ?? 0,
      },
    );

    return parseWikiAssetFolders(data.assets?.folders);
  }

  async createAssetFolder(slug: string, parentFolderId: number | null): Promise<void> {
    const data = await this.graphQlRequest<{
      assets?: {
        createFolder?: {
          responseResult?: WikiResponseResult;
        };
      };
    }>(
      `mutation CreateAssetFolder($slug: String!, $parentFolderId: Int!) {
        assets {
          createFolder(slug: $slug, parentFolderId: $parentFolderId) {
            responseResult {
              succeeded
              message
            }
          }
        }
      }`,
      {
        slug,
        parentFolderId: parentFolderId ?? 0,
      },
    );

    const result = data.assets?.createFolder?.responseResult;
    if (!result?.succeeded) {
      throw new ToolError(result?.message ?? `Wiki.js could not create asset folder ${slug}.`);
    }
  }

  async listAssets(
    folderId: number | null,
    kind: "ALL" | "IMAGE" | "BINARY" = "ALL",
  ): Promise<WikiAssetListItem[]> {
    const data = await this.graphQlRequest<{
      assets?: {
        list?: unknown;
      };
    }>(
      `query ListAssets($folderId: Int!, $kind: AssetKind!) {
        assets {
          list(folderId: $folderId, kind: $kind) {
            id
            filename
            ext
            kind
            fileSize
          }
        }
      }`,
      {
        folderId: folderId ?? 0,
        kind,
      },
    );

    return parseWikiAssetList(data.assets?.list);
  }

  async deleteAsset(id: number): Promise<void> {
    const data = await this.graphQlRequest<{
      assets?: {
        deleteAsset?: {
          responseResult?: WikiResponseResult;
        };
      };
    }>(
      `mutation DeleteAsset($id: Int!) {
        assets {
          deleteAsset(id: $id) {
            responseResult {
              succeeded
              message
            }
          }
        }
      }`,
      {id},
    );

    const result = data.assets?.deleteAsset?.responseResult;
    if (!result?.succeeded) {
      throw new ToolError(result?.message ?? `Wiki.js could not delete asset ${id}.`);
    }
  }

  async uploadAsset(input: WikiAssetUploadInput): Promise<void> {
    if (/[\\/]/.test(input.filename)) {
      throw new ToolError("Wiki.js asset upload filename must not contain path separators.");
    }

    const filename = normalizeWikiPath(input.filename);
    if (!filename) {
      throw new ToolError("Wiki.js asset upload requires a filename.");
    }

    const mimeType = trimToUndefined(input.mimeType) ?? "application/octet-stream";
    const form = new FormData();
    form.append("mediaUpload", JSON.stringify({
      folderId: input.folderId ?? 0,
    }));
    form.append(
      "mediaUpload",
      new Blob([Buffer.from(input.bytes)], {type: mimeType}),
      filename,
    );

    const response = await fetchWiki(this.fetchImpl, buildUploadUrl(this.baseUrl), {
      method: "POST",
      headers: this.buildAuthHeaders(),
      body: form,
    }, "Wiki.js asset upload");

    if (response.ok) {
      return;
    }

    let message: string | undefined;
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (contentType === "application/json") {
      try {
        const payload = await response.json() as {message?: unknown};
        message = pickMessage(payload.message);
      } catch {
        message = undefined;
      }
    } else {
      message = pickMessage(await response.text().catch(() => ""));
    }

    throw new ToolError(message ?? `Wiki.js asset upload failed with status ${response.status}.`);
  }

  async downloadAsset(assetPath: string): Promise<WikiAssetDownloadResult> {
    const response = await fetchWiki(this.fetchImpl, buildAssetUrl(this.baseUrl, assetPath), {
      method: "GET",
      headers: this.buildAuthHeaders(),
    }, "Wiki.js asset download");

    if (!response.ok) {
      let message: string | undefined;
      const contentType = normalizeContentType(response.headers.get("content-type"));
      if (contentType === "application/json") {
        try {
          const payload = await response.json() as {message?: unknown};
          message = pickMessage(payload.message);
        } catch {
          message = undefined;
        }
      } else {
        message = pickMessage(await response.text().catch(() => ""));
      }

      throw new ToolError(message ?? `Wiki.js asset download failed with status ${response.status}.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const sizeBytes = pickInteger(response.headers.get("content-length"));
    return {
      bytes,
      mimeType: normalizeContentType(response.headers.get("content-type")),
      ...(sizeBytes !== undefined ? {sizeBytes} : {}),
    };
  }

  async createPage(input: WikiPageWriteInput): Promise<WikiPage> {
    const locale = normalizeWikiLocale(input.locale);
    const path = normalizeWikiPath(input.path);
    const data = await this.graphQlRequest<{
      pages?: {
        create?: {
          responseResult?: WikiResponseResult;
          page?: unknown;
        };
      };
    }>(
      `mutation CreatePage(
        $content: String!
        $description: String!
        $editor: String!
        $isPublished: Boolean!
        $isPrivate: Boolean!
        $locale: String!
        $path: String!
        $tags: [String]!
        $title: String!
      ) {
        pages {
          create(
            content: $content
            description: $description
            editor: $editor
            isPublished: $isPublished
            isPrivate: $isPrivate
            locale: $locale
            path: $path
            tags: $tags
            title: $title
          ) {
            responseResult {
              succeeded
              message
            }
            page {
              id
            }
          }
        }
      }`,
      {
        content: input.content,
        description: input.description,
        editor: trimToUndefined(input.editor) ?? DEFAULT_WIKI_EDITOR,
        isPublished: input.isPublished ?? true,
        isPrivate: input.isPrivate ?? false,
        locale,
        path,
        tags: normalizeWikiTags(input.tags),
        title: input.title,
      },
    );

    const result = data.pages?.create;
    if (!result?.responseResult?.succeeded) {
      throw new ToolError(result?.responseResult?.message ?? "Wiki.js could not create the page.");
    }
    const page = await this.getPageByPath(path, locale);
    if (!page) {
      throw new ToolError(`Wiki.js created ${locale}/${path} but reloading the page failed.`);
    }
    return page;
  }

  async updatePage(input: WikiPageWriteInput & {id: number}): Promise<WikiPage> {
    const locale = normalizeWikiLocale(input.locale);
    const path = normalizeWikiPath(input.path);
    const data = await this.graphQlRequest<{
      pages?: {
        update?: {
          responseResult?: WikiResponseResult;
          page?: unknown;
        };
      };
    }>(
      `mutation UpdatePage(
        $id: Int!
        $content: String!
        $description: String!
        $editor: String!
        $isPublished: Boolean!
        $isPrivate: Boolean!
        $locale: String!
        $path: String!
        $tags: [String]!
        $title: String!
      ) {
        pages {
          update(
            id: $id
            content: $content
            description: $description
            editor: $editor
            isPublished: $isPublished
            isPrivate: $isPrivate
            locale: $locale
            path: $path
            tags: $tags
            title: $title
          ) {
            responseResult {
              succeeded
              message
            }
            page {
              id
            }
          }
        }
      }`,
      {
        id: input.id,
        content: input.content,
        description: input.description,
        editor: trimToUndefined(input.editor) ?? DEFAULT_WIKI_EDITOR,
        isPublished: input.isPublished ?? true,
        isPrivate: input.isPrivate ?? false,
        locale,
        path,
        tags: normalizeWikiTags(input.tags),
        title: input.title,
      },
    );

    const result = data.pages?.update;
    if (!result?.responseResult?.succeeded) {
      throw new ToolError(result?.responseResult?.message ?? "Wiki.js could not update the page.");
    }
    const page = await this.getPageByPath(path, locale);
    if (!page) {
      throw new ToolError(`Wiki.js updated ${locale}/${path} but reloading the page failed.`);
    }
    return page;
  }

  async movePage(input: WikiPageMoveInput): Promise<WikiPage> {
    const destinationLocale = normalizeWikiLocale(input.destinationLocale);
    const destinationPath = normalizeWikiPath(input.destinationPath);
    const data = await this.graphQlRequest<{
      pages?: {
        move?: {
          responseResult?: WikiResponseResult;
        };
      };
    }>(
      `mutation MovePage(
        $id: Int!
        $destinationPath: String!
        $destinationLocale: String!
      ) {
        pages {
          move(
            id: $id
            destinationPath: $destinationPath
            destinationLocale: $destinationLocale
          ) {
            responseResult {
              succeeded
              message
            }
          }
        }
      }`,
      {
        id: input.id,
        destinationPath,
        destinationLocale,
      },
    );

    const result = data.pages?.move;
    if (!result?.responseResult?.succeeded) {
      throw new ToolError(result?.responseResult?.message ?? "Wiki.js could not move the page.");
    }

    const page = await this.getPageByPath(destinationPath, destinationLocale);
    if (!page) {
      throw new ToolError(
        `Wiki.js moved ${input.id} to ${destinationLocale}/${destinationPath} but reloading the page failed.`,
      );
    }

    return page;
  }

  async checkPageConflicts(id: number, checkoutDate: string): Promise<boolean> {
    const data = await this.graphQlRequest<{
      pages?: {
        checkConflicts?: unknown;
      };
    }>(
      `query CheckPageConflicts($id: Int!, $checkoutDate: Date!) {
        pages {
          checkConflicts(id: $id, checkoutDate: $checkoutDate)
        }
      }`,
      {
        id,
        checkoutDate,
      },
    );

    return data.pages?.checkConflicts === true;
  }

  async getConflictLatest(id: number): Promise<WikiPage> {
    const data = await this.graphQlRequest<{
      pages?: {
        conflictLatest?: unknown;
      };
    }>(
      `query GetConflictLatest($id: Int!) {
        pages {
          conflictLatest(id: $id) {
            id
            path
            locale
            title
            description
            content
            updatedAt
            createdAt
            isPublished
            tags
          }
        }
      }`,
      {
        id,
      },
    );

    const latest = data.pages?.conflictLatest;
    if (!latest) {
      throw new ToolError("Wiki.js did not return the latest conflict version.");
    }
    return parseWikiPage({
      ...latest,
      editor: DEFAULT_WIKI_EDITOR,
      isPrivate: false,
    });
  }
}
