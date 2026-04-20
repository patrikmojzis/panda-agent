import path from "node:path";

import {trimWikiPath} from "./paths.js";

export interface WikiLinkRewriteResult {
  content: string;
  rewrittenLinks: number;
}

type WikiLinkStyle = "absolute_locale" | "absolute_path" | "relative";

interface ParsedWikiLinkTarget {
  fullPath: string;
  hash: string;
  query: string;
  style: WikiLinkStyle;
  wrapped: boolean;
}

const FENCE_RE = /^([`~]{3,})/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
const INLINE_LINK_RE = /\[([^\]]+)\]\((<[^>\n]+>|[^)\s]+)([^)]*)\)/g;
const REFERENCE_LINK_RE = /^(\[[^\]]+\]:[ \t]*)(<[^>\n]+>|[^ \t\n]+)(.*)$/g;
const EXTERNAL_TARGET_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const OPEN_HTML_CODE_TAG_RE = /^<\s*(code|pre)\b[^>]*>/i;

interface ProtectedRange {
  end: number;
  start: number;
}

interface ProtectedState {
  activeFence: string | null;
  activeHtmlCodeTag: "code" | "pre" | null;
  activeHtmlComment: boolean;
  activeInlineCodeDelimiter: string | null;
}

function normalizeFullPath(locale: string, pagePath: string): string {
  return `${locale}/${trimWikiPath(pagePath)}`;
}

function splitWrappedTarget(rawTarget: string): {
  target: string;
  wrapped: boolean;
} {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return {
      target: trimmed.slice(1, -1),
      wrapped: true,
    };
  }

  return {
    target: trimmed,
    wrapped: false,
  };
}

function splitTargetSuffix(target: string): {
  hash: string;
  pathPart: string;
  query: string;
} {
  const hashIndex = target.indexOf("#");
  const beforeHash = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  return {
    pathPart: queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash,
    query: queryIndex >= 0 ? beforeHash.slice(queryIndex) : "",
    hash,
  };
}

function parseInternalWikiTarget(
  rawTarget: string,
  options: {
    locale: string;
    sourcePagePath: string;
  },
): ParsedWikiLinkTarget | null {
  const {target, wrapped} = splitWrappedTarget(rawTarget);
  if (!target || target.startsWith("#") || target.startsWith("//") || EXTERNAL_TARGET_RE.test(target)) {
    return null;
  }

  const {pathPart, query, hash} = splitTargetSuffix(target);
  if (!pathPart) {
    return null;
  }

  if (pathPart.startsWith("/")) {
    const trimmedAbsolutePath = trimWikiPath(pathPart);
    if (!trimmedAbsolutePath) {
      return null;
    }

    if (trimmedAbsolutePath.startsWith(`${options.locale}/`)) {
      return {
        fullPath: trimmedAbsolutePath,
        hash,
        query,
        style: "absolute_locale",
        wrapped,
      };
    }

    return {
      fullPath: normalizeFullPath(options.locale, trimmedAbsolutePath),
      hash,
      query,
      style: "absolute_path",
      wrapped,
    };
  }

  const baseUrl = `https://wiki.local/${normalizeFullPath(options.locale, options.sourcePagePath)}`;
  const resolved = new URL(pathPart, baseUrl);
  const resolvedPath = trimWikiPath(resolved.pathname);
  if (!resolvedPath.startsWith(`${options.locale}/`)) {
    return null;
  }

  return {
    fullPath: resolvedPath,
    hash,
    query,
    style: "relative",
    wrapped,
  };
}

function buildRelativeTarget(
  destinationFullPath: string,
  options: {
    locale: string;
    sourcePagePath: string;
  },
): string {
  const sourceFullPath = normalizeFullPath(options.locale, options.sourcePagePath);
  const relativePath = path.posix.relative(
    path.posix.dirname(sourceFullPath),
    destinationFullPath,
  );

  return relativePath || path.posix.basename(destinationFullPath);
}

function rebuildTarget(
  target: ParsedWikiLinkTarget,
  nextFullPath: string,
  options: {
    locale: string;
    sourcePagePath: string;
  },
): string {
  const nextPath = nextFullPath.slice(`${options.locale}/`.length);
  let nextTarget: string;

  switch (target.style) {
    case "absolute_locale":
      nextTarget = `/${nextFullPath}`;
      break;
    case "absolute_path":
      nextTarget = `/${nextPath}`;
      break;
    case "relative":
      nextTarget = buildRelativeTarget(nextFullPath, options);
      break;
  }

  const rebuilt = `${nextTarget}${target.query}${target.hash}`;
  return target.wrapped ? `<${rebuilt}>` : rebuilt;
}

function readBacktickRun(line: string, start: number): string {
  let end = start + 1;
  while (end < line.length && line[end] === "`") {
    end += 1;
  }
  return line.slice(start, end);
}

function findMatchingBacktickRun(
  line: string,
  start: number,
  delimiter: string,
): number {
  for (let index = start; index < line.length; index += 1) {
    if (line[index] !== "`") {
      continue;
    }

    const run = readBacktickRun(line, index);
    if (run === delimiter) {
      return index;
    }

    index += run.length - 1;
  }

  return -1;
}

function matchOpenHtmlCodeTag(
  line: string,
  start: number,
): {tagName: "code" | "pre"} | null {
  const match = OPEN_HTML_CODE_TAG_RE.exec(line.slice(start));
  if (!match?.[0] || !match[1]) {
    return null;
  }

  const rawTagName = match[1].toLowerCase();
  return rawTagName === "code" || rawTagName === "pre"
    ? {
      tagName: rawTagName,
    }
    : null;
}

function findClosingHtmlCodeTag(
  line: string,
  start: number,
  tagName: "code" | "pre",
): number {
  const closingTagRe = new RegExp(`<\\s*/\\s*${tagName}\\s*>`, "i");
  const match = closingTagRe.exec(line.slice(start));
  return match?.index !== undefined
    ? start + match.index
    : -1;
}

function collectProtectedRanges(
  line: string,
  state: ProtectedState,
): ProtectedRange[] {
  if (state.activeFence) {
    return [{
      start: 0,
      end: line.length,
    }];
  }

  if (!state.activeHtmlComment
    && !state.activeHtmlCodeTag
    && !state.activeInlineCodeDelimiter
    && INDENTED_CODE_RE.test(line)) {
    return [{
      start: 0,
      end: line.length,
    }];
  }

  const ranges: ProtectedRange[] = [];
  let index = 0;

  while (index < line.length) {
    if (state.activeHtmlComment) {
      const endIndex = line.indexOf("-->", index);
      if (endIndex < 0) {
        ranges.push({start: index, end: line.length});
        break;
      }

      ranges.push({start: index, end: endIndex + 3});
      state.activeHtmlComment = false;
      index = endIndex + 3;
      continue;
    }

    if (state.activeHtmlCodeTag) {
      const endIndex = findClosingHtmlCodeTag(line, index, state.activeHtmlCodeTag);
      if (endIndex < 0) {
        ranges.push({start: index, end: line.length});
        break;
      }

      const closingMatch = new RegExp(`<\\s*/\\s*${state.activeHtmlCodeTag}\\s*>`, "i").exec(line.slice(endIndex));
      const closingLength = closingMatch?.[0]?.length ?? 0;
      ranges.push({start: index, end: endIndex + closingLength});
      state.activeHtmlCodeTag = null;
      index = endIndex + closingLength;
      continue;
    }

    if (state.activeInlineCodeDelimiter) {
      const endIndex = findMatchingBacktickRun(
        line,
        index + state.activeInlineCodeDelimiter.length,
        state.activeInlineCodeDelimiter,
      );
      if (endIndex < 0) {
        ranges.push({start: index, end: line.length});
        break;
      }

      ranges.push({
        start: index,
        end: endIndex + state.activeInlineCodeDelimiter.length,
      });
      index = endIndex + state.activeInlineCodeDelimiter.length;
      state.activeInlineCodeDelimiter = null;
      continue;
    }

    if (line.startsWith("<!--", index)) {
      state.activeHtmlComment = true;
      continue;
    }

    if (line[index] === "<") {
      const tagMatch = matchOpenHtmlCodeTag(line, index);
      if (tagMatch) {
        state.activeHtmlCodeTag = tagMatch.tagName;
        continue;
      }
    }

    if (line[index] === "`") {
      state.activeInlineCodeDelimiter = readBacktickRun(line, index);
      continue;
    }

    index += 1;
  }

  return ranges;
}

function rewriteOutsideProtectedRanges(
  line: string,
  protectedRanges: ProtectedRange[],
  options: Parameters<typeof rewriteLineTargets>[1],
): WikiLinkRewriteResult {
  if (protectedRanges.length === 0) {
    return rewriteLineTargets(line, options);
  }

  let content = "";
  let cursor = 0;
  let rewrittenLinks = 0;

  for (const range of protectedRanges) {
    if (range.start > cursor) {
      const rewritten = rewriteLineTargets(line.slice(cursor, range.start), options);
      content += rewritten.content;
      rewrittenLinks += rewritten.rewrittenLinks;
    }

    content += line.slice(range.start, range.end);
    cursor = range.end;
  }

  if (cursor < line.length) {
    const rewritten = rewriteLineTargets(line.slice(cursor), options);
    content += rewritten.content;
    rewrittenLinks += rewritten.rewrittenLinks;
  }

  return {
    content,
    rewrittenLinks,
  };
}

function rewriteLineTargets(
  line: string,
  options: {
    locale: string;
    sourcePagePath: string;
    rewriteTarget: (target: ParsedWikiLinkTarget) => string | null;
  },
): WikiLinkRewriteResult {
  let rewrittenLinks = 0;

  const rewriteMatchTarget = (rawTarget: string): string => {
    const parsed = parseInternalWikiTarget(rawTarget, options);
    if (!parsed) {
      return rawTarget;
    }

    const replacement = options.rewriteTarget(parsed);
    if (!replacement || replacement === rawTarget) {
      return rawTarget;
    }

    rewrittenLinks += 1;
    return replacement;
  };

  const inlineRewritten = line.replace(INLINE_LINK_RE, (_match, label: string, target: string, suffix: string) => (
    `[${label}](${rewriteMatchTarget(target)}${suffix})`
  ));

  const referenceRewritten = inlineRewritten.replace(REFERENCE_LINK_RE, (_match, prefix: string, target: string, suffix: string) => (
    `${prefix}${rewriteMatchTarget(target)}${suffix}`
  ));

  return {
    content: referenceRewritten,
    rewrittenLinks,
  };
}

function rewriteMarkdownWikiLinks(
  document: string,
  options: {
    locale: string;
    sourcePagePath: string;
    rewriteTarget: (target: ParsedWikiLinkTarget) => string | null;
  },
): WikiLinkRewriteResult {
  const lines = document.split("\n");
  const rewrittenLines: string[] = [];
  const protectedState: ProtectedState = {
    activeFence: null,
    activeHtmlCodeTag: null,
    activeHtmlComment: false,
    activeInlineCodeDelimiter: null,
  };
  let rewrittenLinks = 0;

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    const fenceMatch = FENCE_RE.exec(trimmedStart);

    if (protectedState.activeFence) {
      rewrittenLines.push(line);
      if (trimmedStart.startsWith(protectedState.activeFence)) {
        protectedState.activeFence = null;
      }
      continue;
    }

    if (fenceMatch?.[1]) {
      protectedState.activeFence = fenceMatch[1];
      rewrittenLines.push(line);
      continue;
    }

    const protectedRanges = collectProtectedRanges(line, protectedState);
    const rewritten = rewriteOutsideProtectedRanges(line, protectedRanges, options);
    rewrittenLines.push(rewritten.content);
    rewrittenLinks += rewritten.rewrittenLinks;
  }

  return {
    content: rewrittenLines.join("\n"),
    rewrittenLinks,
  };
}

export function retargetWikiLinks(
  document: string,
  options: {
    fromPath: string;
    locale: string;
    sourcePagePath: string;
    toPath: string;
  },
): WikiLinkRewriteResult {
  const fromFullPath = normalizeFullPath(options.locale, options.fromPath);
  const toFullPath = normalizeFullPath(options.locale, options.toPath);

  return rewriteMarkdownWikiLinks(document, {
    locale: options.locale,
    sourcePagePath: options.sourcePagePath,
    rewriteTarget: (target) => (
      target.fullPath === fromFullPath
        ? rebuildTarget(target, toFullPath, {
          locale: options.locale,
          sourcePagePath: options.sourcePagePath,
        })
        : null
    ),
  });
}

export function rewriteRelativeWikiLinksForMovedPage(
  document: string,
  options: {
    destinationPagePath: string;
    locale: string;
    sourcePagePath: string;
  },
): WikiLinkRewriteResult {
  return rewriteMarkdownWikiLinks(document, {
    locale: options.locale,
    sourcePagePath: options.sourcePagePath,
    rewriteTarget: (target) => {
      if (target.style !== "relative") {
        return null;
      }

      return rebuildTarget(target, target.fullPath, {
        locale: options.locale,
        sourcePagePath: options.destinationPagePath,
      });
    },
  });
}
