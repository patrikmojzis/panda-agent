import {ToolError} from "../../kernel/agent/exceptions.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {DEFAULT_WIKI_EDITOR} from "./constants.js";
import {normalizeWikiLocale, normalizeWikiPath} from "./client-input.js";
import type {
  WikiAssetFolder,
  WikiAssetListItem,
  WikiPage,
  WikiPageLinkItem,
  WikiPageListItem,
  WikiPageSearchResult,
} from "./types.js";

export interface GraphQlErrorShape {
  message?: unknown;
}

export interface GraphQlEnvelope<T> {
  data?: T;
  errors?: GraphQlErrorShape[];
}

export interface WikiResponseResult {
  succeeded?: boolean;
  message?: string;
}

export function pickMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function pickInteger(value: unknown): number | undefined {
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

export function normalizeContentType(value: string | null): string | undefined {
  return trimToUndefined(value?.split(";")[0])?.toLowerCase();
}

export function normalizeGraphQlErrors(errors: readonly GraphQlErrorShape[] | undefined): string[] {
  return (errors ?? [])
    .map((error) => pickMessage(error.message))
    .filter((message): message is string => Boolean(message));
}

export function isMissingPageMessage(message: string): boolean {
  return /not found|does not exist/i.test(message);
}

export function parseWikiPage(value: unknown): WikiPage {
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

export function parseWikiSearchResults(value: unknown): WikiPageSearchResult[] {
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

export function parseWikiPageList(value: unknown): WikiPageListItem[] {
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

export function parseWikiPageLinks(value: unknown): WikiPageLinkItem[] {
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

export function parseWikiAssetFolders(value: unknown): WikiAssetFolder[] {
  if (!Array.isArray(value)) {
    throw new ToolError("Wiki.js returned an invalid asset folder list.");
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = pickInteger(entry.id);
    const slug = pickMessage(entry.slug);
    if (id === undefined || !slug) {
      return [];
    }

    return [{
      id,
      slug,
      name: typeof entry.name === "string" ? entry.name : slug,
    }];
  });
}

export function parseWikiAssetList(value: unknown): WikiAssetListItem[] {
  if (!Array.isArray(value)) {
    throw new ToolError("Wiki.js returned an invalid asset list.");
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = pickInteger(entry.id);
    const filename = pickMessage(entry.filename);
    if (id === undefined || !filename) {
      return [];
    }

    const fileSize = pickInteger(entry.fileSize);
    return [{
      id,
      filename,
      ext: typeof entry.ext === "string" ? entry.ext : "",
      kind: typeof entry.kind === "string" ? entry.kind : "UNKNOWN",
      ...(fileSize !== undefined ? {fileSize} : {}),
    }];
  });
}
