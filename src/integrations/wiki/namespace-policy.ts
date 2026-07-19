import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToUndefined} from "../../lib/strings.js";
import {commandScopeDenied} from "../../domain/commands/errors.js";
import {
  DEFAULT_WIKI_LOCALE,
  type WikiPageListItem,
  type WikiPageSearchResult,
} from "./client.js";
import {
  buildWikiArchiveRoot,
  hasUnsafeWikiPathSegments,
  isArchivedWikiPath,
  isWikiAssetPathWithinNamespace,
  isWikiPathWithinNamespace,
} from "./paths.js";

export const DEFAULT_WIKI_LIST_LIMIT = 100;
export const MAX_WIKI_LIST_LIMIT = 500;
export const INTERNAL_WIKI_LIST_SCAN_LIMIT = 1000;

export type WikiPathKind = "page" | "asset";

export interface ResolvedWikiInputPath {
  inputPath: string;
  resolvedPath: string;
}

/**
 * Normalizes user-supplied Wiki.js paths before namespace policy checks.
 */
function normalizeWikiInputPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError("wiki path must not be empty.");
  }
  if (trimmed.startsWith("/") || trimmed.endsWith("/") || hasUnsafeWikiPathSegments(trimmed)) {
    throw new ToolError(`wiki path must not contain empty, '.' , or '..' segments (${value}).`);
  }
  return trimmed;
}

/** Resolves one agent-facing Wiki path before applying page or asset authority. */
export function resolveWikiInputPath(
  value: string,
  namespacePath: string,
  kind: WikiPathKind,
): ResolvedWikiInputPath {
  const inputPath = normalizeWikiInputPath(value);
  const resolvedPath = isWikiPathWithinNamespace(inputPath, namespacePath)
    ? inputPath
    : inputPath.startsWith("agents/")
      ? inputPath
      : `${namespacePath}/${inputPath}`;

  if (kind === "asset") {
    assertWikiNamespaceAssetPath(resolvedPath, namespacePath);
  } else {
    assertWikiNamespacePath(resolvedPath, namespacePath);
  }

  return {inputPath, resolvedPath};
}

/**
 * Normalizes optional operation locale while preserving the Wiki.js default.
 */
export function normalizeWikiInputLocale(value: string | undefined): string {
  return trimToUndefined(value) ?? DEFAULT_WIKI_LOCALE;
}

/**
 * Requires a non-empty markdown section title for section-scoped wiki writes.
 */
export function normalizeWikiSectionTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError("wiki section must not be empty.");
  }

  return trimmed;
}

/**
 * Normalizes Panda-managed image slots to stable Wiki.js asset filenames.
 */
export function normalizeWikiAssetSlot(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new ToolError("wiki attach_image slot must not be empty.");
  }

  return normalized;
}

/**
 * Requires non-empty human-facing image text before inserting markdown.
 */
export function normalizeWikiImageText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError(`wiki attach_image ${label} must not be empty.`);
  }

  return trimmed;
}

/**
 * Builds the timestamped archive destination for a live page.
 */
export function buildWikiArchivePath(path: string, namespacePath: string, now = new Date()): string {
  if (isArchivedWikiPath(path, namespacePath)) {
    throw new ToolError(`Wiki page ${path} is already archived.`);
  }

  const leaf = path.split("/").filter(Boolean).at(-1) ?? "page";
  const safeLeaf = leaf.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "page";
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();

  return `${buildWikiArchiveRoot(namespacePath)}/${year}/${month}/${safeLeaf}-${timestamp}`;
}

/**
 * Enforces that page operations stay inside the current agent namespace.
 */
export function assertWikiNamespacePath(path: string, namespacePath: string): void {
  if (!isWikiPathWithinNamespace(path, namespacePath)) {
    throw commandScopeDenied(
      "The Wiki path is outside the current agent namespace.",
      "resource_scope_denied",
      "Use a relative path in the current agent namespace or a canonical path returned for this agent.",
    );
  }
}

/**
 * Enforces that asset operations stay inside the current agent asset namespace.
 */
export function assertWikiNamespaceAssetPath(path: string, namespacePath: string): void {
  if (!isWikiAssetPathWithinNamespace(path, namespacePath)) {
    throw commandScopeDenied(
      "The Wiki asset path is outside the current agent asset namespace.",
      "resource_scope_denied",
      "Use a relative _assets path in the current agent namespace or a canonical asset path returned for this agent.",
    );
  }
}

/**
 * Filters Wiki.js search results after fetch because Wiki.js path filtering is loose.
 */
export function filterWikiSearchResultsToScope(
  results: WikiPageSearchResult[],
  scopePath: string,
  namespacePath: string,
): WikiPageSearchResult[] {
  const includeArchived = isArchivedWikiPath(scopePath, namespacePath);
  return results.filter((entry) => (
    isWikiPathWithinNamespace(entry.path, scopePath)
    && (includeArchived || !isArchivedWikiPath(entry.path, namespacePath))
  ));
}

/**
 * Filters Wiki.js list results to one namespace subtree and optional archives.
 */
export function filterWikiListedPagesToScope(
  pages: WikiPageListItem[],
  scopePath: string,
  namespacePath: string,
  includeArchived: boolean,
): WikiPageListItem[] {
  return pages.filter((page) => (
    isWikiPathWithinNamespace(page.path, scopePath)
    && isWikiPathWithinNamespace(page.path, namespacePath)
    && (includeArchived || !isArchivedWikiPath(page.path, namespacePath))
  ));
}

/**
 * Clamps model-supplied list limits to the small public wiki tool interface.
 */
export function normalizeWikiListLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WIKI_LIST_LIMIT;
  }

  if (!Number.isFinite(value)) {
    return DEFAULT_WIKI_LIST_LIMIT;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > MAX_WIKI_LIST_LIMIT) {
    return MAX_WIKI_LIST_LIMIT;
  }
  return normalized;
}
