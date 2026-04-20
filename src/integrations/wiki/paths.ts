/**
 * Trims a wiki path and removes leading or trailing slashes without changing
 * the path's internal segments.
 */
export function trimWikiPath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
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
 * Returns true when `path` already points into the namespace archive tree.
 */
export function isArchivedWikiPath(path: string, namespacePath: string): boolean {
  const archiveRoot = buildWikiArchiveRoot(namespacePath);
  return path === archiveRoot || path.startsWith(`${archiveRoot}/`);
}
