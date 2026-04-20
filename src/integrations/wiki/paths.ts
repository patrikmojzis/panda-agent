/**
 * Trims a wiki path and removes leading or trailing slashes without changing
 * the path's internal segments.
 */
export function trimWikiPath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Returns true when a wiki path contains empty, current-directory, or parent
 * directory segments.
 */
export function hasUnsafeWikiPathSegments(value: string): boolean {
  return trimWikiPath(value)
    .split("/")
    .some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

/**
 * Removes the locale prefix from a full `locale/path` wiki path when present.
 */
export function stripWikiLocalePrefix(fullPath: string, locale: string): string {
  const prefix = `${locale}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

/**
 * Returns true when `path` is the namespace root itself or one of its
 * descendants.
 */
export function isWikiPathWithinNamespace(path: string, namespacePath: string): boolean {
  return path === namespacePath || path.startsWith(`${namespacePath}/`);
}

/**
 * Returns the archive root for a namespace.
 */
export function buildWikiArchiveRoot(namespacePath: string): string {
  return `${namespacePath}/_archive`;
}

/**
 * Returns the asset root for a namespace.
 */
export function buildWikiAssetRoot(namespacePath: string): string {
  return `${namespacePath}/_assets`;
}

/**
 * Normalizes one wiki asset path segment to the same lowercase slug format the
 * Wiki.js asset folder API uses.
 */
export function normalizeWikiAssetPathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "page";
}

/**
 * Returns true when `path` already points into the namespace archive tree.
 */
export function isArchivedWikiPath(path: string, namespacePath: string): boolean {
  const archiveRoot = buildWikiArchiveRoot(namespacePath);
  return path === archiveRoot || path.startsWith(`${archiveRoot}/`);
}

/**
 * Returns true when `path` points at the namespace asset root or one of its
 * descendants.
 */
export function isWikiAssetPathWithinNamespace(path: string, namespacePath: string): boolean {
  const assetRoot = buildWikiAssetRoot(namespacePath);
  return isWikiPathWithinNamespace(path, assetRoot);
}

/**
 * Builds the per-page asset directory under the namespace asset root.
 */
export function buildWikiPageAssetDirectory(namespacePath: string, pagePath: string): string {
  const normalizedNamespace = trimWikiPath(namespacePath);
  const normalizedPagePath = trimWikiPath(pagePath);
  if (!isWikiPathWithinNamespace(normalizedPagePath, normalizedNamespace)) {
    throw new Error(`Wiki page path ${pagePath} is outside namespace ${namespacePath}.`);
  }

  const relativePagePath = normalizedPagePath === normalizedNamespace
    ? ""
    : normalizedPagePath.slice(normalizedNamespace.length + 1);
  const assetRoot = buildWikiAssetRoot(normalizedNamespace);
  if (!relativePagePath) {
    return assetRoot;
  }

  const assetRelativePath = relativePagePath
    .split("/")
    .filter(Boolean)
    .map((segment) => normalizeWikiAssetPathSegment(segment))
    .join("/");
  return `${assetRoot}/${assetRelativePath}`;
}
