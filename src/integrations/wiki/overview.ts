import type {WikiBindingService} from "../../domain/wiki/service.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
  DEFAULT_WIKI_LOCALE,
  resolveWikiUrl,
  type WikiPageLinkItem,
  type WikiPageListItem,
  WikiJsClient,
} from "./client.js";
import {
  isArchivedWikiPath,
  isWikiPathWithinNamespace,
  stripWikiLocalePrefix,
  trimWikiPath,
} from "./paths.js";

export const DEFAULT_WIKI_OVERVIEW_RECENT_LIMIT = 10;
export const DEFAULT_WIKI_OVERVIEW_LINKED_LIMIT = 20;
export const DEFAULT_WIKI_OVERVIEW_CACHE_TTL_MS = 10 * 60 * 1_000;

const MIN_RECENT_SCAN_LIMIT = 100;
const RECENT_SCAN_MULTIPLIER = 10;

export interface WikiOverviewRecentEntry {
  title: string;
  path: string;
  updatedAt: string;
}

export interface WikiOverviewLinkedEntry {
  title: string;
  path: string;
  inboundLinks: number;
}

export interface WikiOverviewKeyPage {
  title: string;
  path: string;
}

export interface WikiOverviewSnapshot {
  namespacePath: string;
  locale: string;
  recentlyEdited: readonly WikiOverviewRecentEntry[];
  topLinked: readonly WikiOverviewLinkedEntry[];
}

export interface WikiOverviewReaderOptions {
  bindings: Pick<WikiBindingService, "getBinding">;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date | (() => Date);
}

export interface ReadWikiOverviewInput {
  agentKey: string;
  locale?: string;
  recentLimit?: number;
  linkedLimit?: number;
  ttlMs?: number;
}

const overviewCache = new Map<string, {expiresAt: number; snapshot: WikiOverviewSnapshot}>();

function resolveNow(now?: Date | (() => Date)): Date {
  return typeof now === "function" ? now() : now ?? new Date();
}

function buildCacheKey(options: {
  agentKey: string;
  baseUrl: string;
  namespacePath: string;
  locale: string;
  recentLimit: number;
  linkedLimit: number;
}): string {
  return [
    options.agentKey,
    options.baseUrl,
    options.namespacePath,
    options.locale,
    String(options.recentLimit),
    String(options.linkedLimit),
  ].join("::");
}

function fallbackTitle(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function compareUpdatedAtDescending(a: WikiPageListItem, b: WikiPageListItem): number {
  const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return Number.isFinite(dateDiff) && dateDiff !== 0 ? dateDiff : a.path.localeCompare(b.path);
}

function compareTopLinked(
  a: {title: string; path: string; inboundLinks: number},
  b: {title: string; path: string; inboundLinks: number},
): number {
  return b.inboundLinks - a.inboundLinks
    || a.title.localeCompare(b.title)
    || a.path.localeCompare(b.path);
}

function buildRecentlyEdited(
  pages: readonly WikiPageListItem[],
  options: {locale: string; namespacePath: string; limit: number},
): WikiOverviewRecentEntry[] {
  return [...pages]
    .filter((page) => (
      page.locale === options.locale
      && isWikiPathWithinNamespace(page.path, options.namespacePath)
      && !isArchivedWikiPath(page.path, options.namespacePath)
    ))
    .sort(compareUpdatedAtDescending)
    .slice(0, options.limit)
    .map((page) => ({
      title: trimToUndefined(page.title) ?? fallbackTitle(page.path),
      path: page.path,
      updatedAt: page.updatedAt,
    }));
}

function resolveRecentScanLimit(limit: number): number {
  return Math.max(limit, Math.max(MIN_RECENT_SCAN_LIMIT, limit * RECENT_SCAN_MULTIPLIER));
}

function buildTopLinked(
  linkItems: readonly WikiPageLinkItem[],
  options: {locale: string; namespacePath: string; limit: number},
): WikiOverviewLinkedEntry[] {
  const namespacePrefix = `${options.locale}/${options.namespacePath}`;
  const isWithinNamespace = (fullPath: string) => (
    fullPath === namespacePrefix || fullPath.startsWith(`${namespacePrefix}/`)
  );
  const titleByFullPath = new Map<string, string>();
  const inboundCounts = new Map<string, number>();

  for (const item of linkItems) {
    if (isWithinNamespace(item.path) && !isArchivedWikiPath(stripWikiLocalePrefix(item.path, options.locale), options.namespacePath)) {
      titleByFullPath.set(item.path, item.title);
    }
  }

  for (const item of linkItems) {
    if (
      !isWithinNamespace(item.path)
      || isArchivedWikiPath(stripWikiLocalePrefix(item.path, options.locale), options.namespacePath)
    ) {
      continue;
    }

    for (const linkedPath of item.links) {
      if (
        !isWithinNamespace(linkedPath)
        || isArchivedWikiPath(stripWikiLocalePrefix(linkedPath, options.locale), options.namespacePath)
      ) {
        continue;
      }

      inboundCounts.set(linkedPath, (inboundCounts.get(linkedPath) ?? 0) + 1);
    }
  }

  return [...inboundCounts.entries()]
    .map(([fullPath, inboundLinks]) => {
      const path = stripWikiLocalePrefix(fullPath, options.locale);
      return {
        title: trimToUndefined(titleByFullPath.get(fullPath)) ?? fallbackTitle(path),
        path,
        inboundLinks,
      };
    })
    .sort(compareTopLinked)
    .slice(0, options.limit);
}

/** Selects cache-stable key pages from a ranked Wiki overview snapshot. */
export function selectWikiOverviewKeyPages(
  topLinked: readonly WikiOverviewLinkedEntry[],
): WikiOverviewKeyPage[] {
  return topLinked
    .map(({title, path}) => ({title, path}))
    .sort((left, right) => left.path.localeCompare(right.path) || left.title.localeCompare(right.title));
}

/** Reads a bounded namespace-scoped Wiki discovery snapshot behind one cached interface. */
export class WikiOverviewReader {
  private readonly options: WikiOverviewReaderOptions;

  constructor(options: WikiOverviewReaderOptions) {
    this.options = options;
  }

  async read(input: ReadWikiOverviewInput): Promise<WikiOverviewSnapshot | null> {
    const binding = await this.options.bindings.getBinding(input.agentKey);
    if (!binding) {
      return null;
    }

    const locale = trimToUndefined(input.locale) ?? DEFAULT_WIKI_LOCALE;
    const namespacePath = trimWikiPath(binding.namespacePath);
    const baseUrl = resolveWikiUrl(this.options.env);
    const recentLimit = input.recentLimit ?? DEFAULT_WIKI_OVERVIEW_RECENT_LIMIT;
    const linkedLimit = input.linkedLimit ?? DEFAULT_WIKI_OVERVIEW_LINKED_LIMIT;
    const ttlMs = input.ttlMs ?? DEFAULT_WIKI_OVERVIEW_CACHE_TTL_MS;
    const now = resolveNow(this.options.now).getTime();
    const cacheKey = buildCacheKey({
      agentKey: input.agentKey,
      baseUrl,
      namespacePath,
      locale,
      recentLimit,
      linkedLimit,
    });

    if (ttlMs > 0) {
      const cached = overviewCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.snapshot;
      }
    }

    const client = new WikiJsClient({
      apiToken: binding.apiToken,
      baseUrl,
      fetchImpl: this.options.fetchImpl,
    });
    const [pages, links] = await Promise.all([
      recentLimit > 0
        ? client.listPages({
          limit: resolveRecentScanLimit(recentLimit),
          locale,
          orderBy: "UPDATED",
          orderByDirection: "DESC",
        })
        : Promise.resolve([]),
      linkedLimit > 0 ? client.listPageLinks(locale) : Promise.resolve([]),
    ]);
    const snapshot: WikiOverviewSnapshot = {
      namespacePath,
      locale,
      recentlyEdited: buildRecentlyEdited(pages, {locale, namespacePath, limit: recentLimit}),
      topLinked: buildTopLinked(links, {locale, namespacePath, limit: linkedLimit}),
    };

    if (ttlMs > 0) {
      overviewCache.set(cacheKey, {expiresAt: now + ttlMs, snapshot});
    }

    return snapshot;
  }
}
