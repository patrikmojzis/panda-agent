import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToUndefined, uniqueTrimmedStrings} from "../../lib/strings.js";
import {DEFAULT_WIKI_LOCALE} from "./constants.js";
import {hasUnsafeWikiPathSegments, trimWikiPath} from "./paths.js";

/** Normalizes Wiki.js page and asset paths before they cross the client seam. */
export function normalizeWikiPath(value: string): string {
  const withoutSlashes = trimWikiPath(value);
  if (!withoutSlashes) {
    throw new ToolError("Wiki path must not be empty.");
  }
  if (hasUnsafeWikiPathSegments(withoutSlashes)) {
    throw new ToolError(`Wiki path must not contain empty, '.', or '..' segments (${value}).`);
  }
  return withoutSlashes;
}

/** Applies the Wiki.js default locale while keeping callers free of env details. */
export function normalizeWikiLocale(value: string | undefined): string {
  return trimToUndefined(value) ?? DEFAULT_WIKI_LOCALE;
}

/** Removes empty and duplicate tag values before sending mutations to Wiki.js. */
export function normalizeWikiTags(value: readonly string[] | undefined): string[] {
  return uniqueTrimmedStrings(value ?? []);
}
