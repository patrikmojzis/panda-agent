import type {WikiBindingService} from "../../domain/wiki/index.js";
import {
    DEFAULT_WIKI_LOCALE,
    resolveWikiUrl,
    WikiJsClient,
    type WikiPageLinkItem,
    type WikiPageListItem,
} from "../../integrations/wiki/client.js";
import {LlmContext} from "../../kernel/agent/llm-context.js";
import {
    renderWikiOverviewContext,
    type WikiOverviewLinkedEntry,
    type WikiOverviewRecentEntry,
} from "../../prompts/contexts/wiki-overview.js";

const DEFAULT_RECENT_LIMIT = 10;
const DEFAULT_LINK_LIMIT = 10;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;
const MIN_RECENT_SCAN_LIMIT = 100;
const RECENT_SCAN_MULTIPLIER = 10;

interface WikiOverviewSnapshot {
  fetchedAt: number;
  namespacePath: string;
  recentlyEdited: WikiOverviewRecentEntry[];
  topLinked: WikiOverviewLinkedEntry[];
}

const overviewCache = new Map<string, {expiresAt: number; snapshot: WikiOverviewSnapshot}>();

export interface WikiOverviewContextOptions {
  agentKey: string;
  bindings: Pick<WikiBindingService, "getBinding">;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  locale?: string;
  recentLimit?: number;
  linkedLimit?: number;
  ttlMs?: number;
  now?: Date | (() => Date);
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function isPathWithinNamespace(path: string, namespacePath: string): boolean {
  return path === namespacePath || path.startsWith(`${namespacePath}/`);
}

function isArchivedPath(path: string, namespacePath: string): boolean {
  const archiveRoot = `${namespacePath}/_archive`;
  return path === archiveRoot || path.startsWith(`${archiveRoot}/`);
}

function resolveNow(now?: Date | (() => Date)): Date {
  if (typeof now === "function") {
    return now();
  }

  return now ?? new Date();
}

function formatRelativeAge(ageMs: number): string {
  if (ageMs < 5_000) {
    return "just now";
  }
  if (ageMs < 60_000) {
    return `${Math.floor(ageMs / 1_000)}s ago`;
  }
  if (ageMs < 60 * 60 * 1_000) {
    return `${Math.floor(ageMs / 60_000)}m ago`;
  }
  if (ageMs < 24 * 60 * 60 * 1_000) {
    return `${Math.floor(ageMs / (60 * 60 * 1_000))}h ago`;
  }

  return `${Math.floor(ageMs / (24 * 60 * 60 * 1_000))}d ago`;
}

function formatCompactDuration(durationMs: number): string {
  if (durationMs % (24 * 60 * 60 * 1_000) === 0) {
    return `${durationMs / (24 * 60 * 60 * 1_000)}d`;
  }
  if (durationMs % (60 * 60 * 1_000) === 0) {
    return `${durationMs / (60 * 60 * 1_000)}h`;
  }
  if (durationMs % 60_000 === 0) {
    return `${durationMs / 60_000}m`;
  }
  if (durationMs % 1_000 === 0) {
    return `${durationMs / 1_000}s`;
  }

  return `${durationMs}ms`;
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

function fullPathToNamespacePath(fullPath: string, locale: string): string {
  const prefix = `${locale}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

function fallbackTitle(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function compareUpdatedAtDescending(a: WikiPageListItem, b: WikiPageListItem): number {
  const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (Number.isFinite(dateDiff) && dateDiff !== 0) {
    return dateDiff;
  }

  return a.path.localeCompare(b.path);
}

function compareTopLinked(
  a: {title: string; path: string; inboundLinks: number},
  b: {title: string; path: string; inboundLinks: number},
): number {
  if (b.inboundLinks !== a.inboundLinks) {
    return b.inboundLinks - a.inboundLinks;
  }

  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) {
    return titleDiff;
  }

  return a.path.localeCompare(b.path);
}

function buildRecentlyEdited(
  pages: WikiPageListItem[],
  options: {
    locale: string;
    namespacePath: string;
    limit: number;
  },
) {
  return pages
    .filter((page) => (
      page.locale === options.locale
      && isPathWithinNamespace(page.path, options.namespacePath)
      && !isArchivedPath(page.path, options.namespacePath)
    ))
    .sort(compareUpdatedAtDescending)
    .slice(0, options.limit)
    .map((page) => ({
      title: trimNonEmpty(page.title) ?? fallbackTitle(page.path),
      path: page.path,
      updatedAt: page.updatedAt,
    }));
}

function resolveRecentScanLimit(limit: number): number {
  return Math.max(limit, Math.max(MIN_RECENT_SCAN_LIMIT, limit * RECENT_SCAN_MULTIPLIER));
}

function buildTopLinked(
  linkItems: WikiPageLinkItem[],
  options: {
    locale: string;
    namespacePath: string;
    limit: number;
  },
) {
  const namespacePrefix = `${options.locale}/${options.namespacePath}`;
  const isWithinNamespace = (fullPath: string) => (
    fullPath === namespacePrefix || fullPath.startsWith(`${namespacePrefix}/`)
  );
  const titleByFullPath = new Map<string, string>();
  const inboundCounts = new Map<string, number>();

  for (const item of linkItems) {
    if (isWithinNamespace(item.path) && !isArchivedPath(fullPathToNamespacePath(item.path, options.locale), options.namespacePath)) {
      titleByFullPath.set(item.path, item.title);
    }
  }

  for (const item of linkItems) {
    if (
      !isWithinNamespace(item.path)
      || isArchivedPath(fullPathToNamespacePath(item.path, options.locale), options.namespacePath)
    ) {
      continue;
    }

    for (const linkedPath of item.links) {
      if (
        !isWithinNamespace(linkedPath)
        || isArchivedPath(fullPathToNamespacePath(linkedPath, options.locale), options.namespacePath)
      ) {
        continue;
      }

      inboundCounts.set(linkedPath, (inboundCounts.get(linkedPath) ?? 0) + 1);
    }
  }

  return [...inboundCounts.entries()]
    .map(([fullPath, inboundLinks]) => {
      const path = fullPathToNamespacePath(fullPath, options.locale);
      return {
        title: trimNonEmpty(titleByFullPath.get(fullPath)) ?? fallbackTitle(path),
        path,
        inboundLinks,
      };
    })
    .sort(compareTopLinked)
    .slice(0, options.limit);
}

function renderSnapshot(
  snapshot: WikiOverviewSnapshot,
  options: {
    now: number;
    ttlMs: number;
  },
): string {
  return renderWikiOverviewContext({
    namespacePath: snapshot.namespacePath,
    lastRefreshed: formatRelativeAge(Math.max(0, options.now - snapshot.fetchedAt)),
    cacheTtl: options.ttlMs > 0 ? formatCompactDuration(options.ttlMs) : undefined,
    recentlyEdited: snapshot.recentlyEdited,
    topLinked: snapshot.topLinked,
  });
}

export class WikiOverviewContext extends LlmContext {
  override name = "Wiki Overview";

  private readonly options: WikiOverviewContextOptions;

  constructor(options: WikiOverviewContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const binding = await this.options.bindings.getBinding(this.options.agentKey);
    if (!binding) {
      return "";
    }

    const locale = trimNonEmpty(this.options.locale) ?? DEFAULT_WIKI_LOCALE;
    const namespacePath = normalizePath(binding.namespacePath);
    const baseUrl = resolveWikiUrl(this.options.env);
    const recentLimit = this.options.recentLimit ?? DEFAULT_RECENT_LIMIT;
    const linkedLimit = this.options.linkedLimit ?? DEFAULT_LINK_LIMIT;
    const ttlMs = this.options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = resolveNow(this.options.now).getTime();
    const cacheKey = buildCacheKey({
      agentKey: this.options.agentKey,
      baseUrl,
      namespacePath,
      locale,
      recentLimit,
      linkedLimit,
    });

    if (ttlMs > 0) {
      const cached = overviewCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return renderSnapshot(cached.snapshot, {
          now,
          ttlMs,
        });
      }
    }

    try {
      const client = new WikiJsClient({
        apiToken: binding.apiToken,
        baseUrl,
        fetchImpl: this.options.fetchImpl,
      });
      const recentScanLimit = resolveRecentScanLimit(recentLimit);
      const [pages, links] = await Promise.all([
        // Wiki.js cannot scope or paginate pages.list by namespace, so pull a wider
        // updated window first, then filter it down to the agent namespace locally.
        client.listPages({
          limit: recentScanLimit,
          locale,
          orderBy: "UPDATED",
          orderByDirection: "DESC",
        }),
        client.listPageLinks(locale),
      ]);

      const snapshot: WikiOverviewSnapshot = {
        fetchedAt: now,
        namespacePath,
        recentlyEdited: buildRecentlyEdited(pages, {
          locale,
          namespacePath,
          limit: recentLimit,
        }),
        topLinked: buildTopLinked(links, {
          locale,
          namespacePath,
          limit: linkedLimit,
        }),
      };

      if (ttlMs > 0) {
        // Cache the small overview snapshot so the age line can stay truthful on cache hits.
        overviewCache.set(cacheKey, {
          expiresAt: now + ttlMs,
          snapshot,
        });
      }

      return renderSnapshot(snapshot, {
        now,
        ttlMs,
      });
    } catch {
      // A flaky wiki overview should not stop the whole agent from booting a prompt.
      return "";
    }
  }
}
