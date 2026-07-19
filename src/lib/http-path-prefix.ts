/**
 * Normalizes a URL path prefix for services that may run below a reverse-proxy
 * mount point. Empty and root prefixes are represented as an empty string.
 */
export function normalizeHttpPathPrefix(value: string | null | undefined, label = "path prefix"): string {
  const raw = value?.trim();
  if (!raw || raw === "/") {
    return "";
  }
  if (!raw.startsWith("/")) {
    throw new Error(`${label} must start with /.`);
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new Error(`${label} must not include query or fragment components.`);
  }

  const normalized = raw.replace(/\/+$/, "");
  for (const segment of normalized.split("/").filter(Boolean)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`${label} contains a malformed path segment.`);
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error(`${label} contains an unsafe path segment.`);
    }
  }

  return normalized;
}

/**
 * Removes `prefix` from an absolute request pathname when present.
 */
export function stripHttpPathPrefix(pathname: string, prefix: string): string {
  const normalizedPrefix = normalizeHttpPathPrefix(prefix);
  if (!normalizedPrefix) {
    return pathname || "/";
  }
  if (pathname === normalizedPrefix) {
    return "/";
  }
  if (pathname.startsWith(`${normalizedPrefix}/`)) {
    return pathname.slice(normalizedPrefix.length) || "/";
  }
  return pathname || "/";
}

/**
 * Prepends `prefix` to an absolute path, preserving rootless callers by forcing
 * a single slash boundary.
 */
export function prependHttpPathPrefix(path: string, prefix: string): string {
  const normalizedPrefix = normalizeHttpPathPrefix(prefix);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedPrefix ? `${normalizedPrefix}${normalizedPath}` : normalizedPath;
}
