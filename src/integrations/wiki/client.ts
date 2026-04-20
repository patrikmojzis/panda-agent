import {ToolError} from "../../kernel/agent/exceptions.js";

export const DEFAULT_WIKI_URL = "http://wiki:3000";
export const DEFAULT_WIKI_LOCALE = "en";
export const DEFAULT_WIKI_EDITOR = "markdown";

export interface WikiJsClientOptions {
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WikiPage {
  id: number;
  path: string;
  locale: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  editor: string;
  isPublished: boolean;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPageSearchResult {
  id: string;
  path: string;
  locale: string;
  title: string;
  description: string;
}

export interface WikiPageListItem {
  id: number;
  path: string;
  locale: string;
  title: string;
  updatedAt: string;
}

export interface WikiPageLinkItem {
  id: number;
  path: string;
  title: string;
  links: string[];
}

export interface WikiPageWriteInput {
  id?: number;
  path: string;
  locale?: string;
  title: string;
  description: string;
  content: string;
  tags?: readonly string[];
  editor?: string;
  isPublished?: boolean;
  isPrivate?: boolean;
}

export interface WikiPageMoveInput {
  id: number;
  destinationPath: string;
  destinationLocale?: string;
}

interface GraphQlErrorShape {
  message?: unknown;
}

interface GraphQlEnvelope<T> {
  data?: T;
  errors?: GraphQlErrorShape[];
}

interface WikiResponseResult {
  succeeded?: boolean;
  message?: string;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeWikiPath(value: string): string {
  const trimmed = value.trim();
  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, "");
  if (!withoutSlashes) {
    throw new ToolError("Wiki path must not be empty.");
  }
  if (withoutSlashes.includes("//")) {
    throw new ToolError(`Wiki path must not contain // (${value}).`);
  }
  return withoutSlashes;
}

function normalizeWikiLocale(value: string | undefined): string {
  const locale = trimNonEmpty(value) ?? DEFAULT_WIKI_LOCALE;
  return locale;
}

function normalizeWikiTags(value: readonly string[] | undefined): string[] {
  return [...new Set(
    (value ?? [])
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  )];
}

function buildGraphQlUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/g, "");
  url.pathname = `${basePath}/graphql`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function pickMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeGraphQlErrors(errors: readonly GraphQlErrorShape[] | undefined): string[] {
  return (errors ?? [])
    .map((error) => pickMessage(error.message))
    .filter((message): message is string => Boolean(message));
}

function isMissingPageMessage(message: string): boolean {
  return /not found|does not exist/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWikiPage(value: unknown): WikiPage {
  if (!isRecord(value)) {
    throw new ToolError("Wiki.js returned an invalid page payload.");
  }

  const id = typeof value.id === "number" ? value.id : Number(value.id);
  if (!Number.isFinite(id)) {
    throw new ToolError("Wiki.js page payload did not include a valid id.");
  }

  const tags = Array.isArray(value.tags)
    ? value.tags
      .map((tag) => {
        if (isRecord(tag) && typeof tag.tag === "string") {
          return tag.tag;
        }
        if (typeof tag === "string") {
          return tag;
        }
        return null;
      })
      .filter((tag): tag is string => typeof tag === "string")
    : [];

  return {
    id,
    path: normalizeWikiPath(String(value.path ?? "")),
    locale: normalizeWikiLocale(typeof value.locale === "string" ? value.locale : undefined),
    title: typeof value.title === "string" ? value.title : "",
    description: typeof value.description === "string" ? value.description : "",
    content: typeof value.content === "string" ? value.content : "",
    tags,
    editor: typeof value.editor === "string" && value.editor.trim() ? value.editor : DEFAULT_WIKI_EDITOR,
    isPublished: value.isPublished === true,
    isPrivate: value.isPrivate === true,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

function parseWikiSearchResults(value: unknown): WikiPageSearchResult[] {
  if (!Array.isArray(value)) {
    throw new ToolError("Wiki.js returned invalid search results.");
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = pickMessage(entry.id);
    const path = pickMessage(entry.path);
    const locale = pickMessage(entry.locale);
    if (!id || !path || !locale) {
      return [];
    }

    return [{
      id,
      path: normalizeWikiPath(path),
      locale,
      title: typeof entry.title === "string" ? entry.title : "",
      description: typeof entry.description === "string" ? entry.description : "",
    }];
  });
}

function parseWikiPageList(value: unknown): WikiPageListItem[] {
  if (!Array.isArray(value)) {
    throw new ToolError("Wiki.js returned an invalid page list.");
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = typeof entry.id === "number" ? entry.id : Number(entry.id);
    const path = pickMessage(entry.path);
    const locale = pickMessage(entry.locale);
    if (!Number.isFinite(id) || !path || !locale) {
      return [];
    }

    return [{
      id,
      path: normalizeWikiPath(path),
      locale: normalizeWikiLocale(locale),
      title: typeof entry.title === "string" ? entry.title : "",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
    }];
  });
}

function parseWikiPageLinks(value: unknown): WikiPageLinkItem[] {
  if (!Array.isArray(value)) {
    throw new ToolError("Wiki.js returned invalid page links.");
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = typeof entry.id === "number" ? entry.id : Number(entry.id);
    const path = pickMessage(entry.path);
    if (!Number.isFinite(id) || !path) {
      return [];
    }

    return [{
      id,
      path: normalizeWikiPath(path),
      title: typeof entry.title === "string" ? entry.title : "",
      links: Array.isArray(entry.links)
        ? entry.links
          .filter((link): link is string => typeof link === "string" && link.trim().length > 0)
          .map((link) => normalizeWikiPath(link))
        : [],
    }];
  });
}

export function resolveWikiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmpty(env.WIKI_URL) ?? DEFAULT_WIKI_URL;
}

export class WikiJsClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WikiJsClientOptions) {
    const apiToken = trimNonEmpty(options.apiToken);
    if (!apiToken) {
      throw new ToolError("Wiki.js client requires an API token.");
    }

    this.apiToken = apiToken;
    this.baseUrl = trimNonEmpty(options.baseUrl) ?? DEFAULT_WIKI_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async graphQlRequest<TData>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<TData> {
    const response = await this.fetchImpl(buildGraphQlUrl(this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

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
        editor: trimNonEmpty(input.editor) ?? DEFAULT_WIKI_EDITOR,
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
        editor: trimNonEmpty(input.editor) ?? DEFAULT_WIKI_EDITOR,
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
