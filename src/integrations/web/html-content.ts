import {Readability} from "@mozilla/readability";
import {parseHTML} from "linkedom";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {
  normalizeTextBlockWhitespace,
  stripInvisibleUnicode,
  trimToUndefined,
  truncateTextWithStatus,
} from "../../lib/strings.js";

const MAX_HTML_CHARS_FOR_READABILITY = 1_000_000;
const HIDDEN_CLASS_NAMES = new Set([
  "hidden",
  "invisible",
  "sr-only",
  "screen-reader-only",
  "visually-hidden",
]);

type PageMetadata = {
  title?: string;
  description?: string;
  siteName?: string;
  canonicalUrl?: string;
};

type HtmlDocument = ReturnType<typeof parseHTML>["document"];
type HtmlElementLike = {
  tagName: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  remove(): void;
};

export type WebFetchLink = {
  text: string;
  url: string;
};

type ReadableWebContent = {
  title?: string;
  description?: string;
  siteName?: string;
  canonicalUrl?: string;
  content: string;
  links: readonly WebFetchLink[];
};

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

/** Returns true when a response body looks like HTML even if the content type is wrong. */
export function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart().slice(0, 512).toLowerCase();
  if (!trimmed) {
    return false;
  }

  return trimmed.startsWith("<!doctype html")
    || trimmed.startsWith("<html")
    || /<(head|body|article|main|p|div)\b/.test(trimmed);
}

/** Strips markup and hidden Unicode from a server-provided HTML error snippet. */
export function sanitizeHtmlTextSnippet(value: string, maxChars = 4_000): string {
  const trimmed = normalizeTextBlockWhitespace(stripInvisibleUnicode(stripTags(value)));
  if (!trimmed) {
    return "";
  }

  return truncateTextWithStatus(trimmed, maxChars).text;
}

function absolutizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(rawUrl, baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

function absolutizeAnchors(html: string, baseUrl: string): string {
  const {document} = parseHTML(`<html><body>${html}</body></html>`);
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = trimToUndefined(anchor.getAttribute("href"));
    if (!href) {
      anchor.removeAttribute("href");
      continue;
    }

    const absolute = absolutizeUrl(href, baseUrl);
    if (absolute) {
      anchor.setAttribute("href", absolute);
      continue;
    }

    anchor.removeAttribute("href");
  }

  return document.body?.innerHTML ?? html;
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = absolutizeAnchors(html, baseUrl)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeTextBlockWhitespace(stripTags(body));
    return label ? `[${label}](${href})` : href;
  });
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeTextBlockWhitespace(stripTags(body));
    return label ? `\n${prefix} ${label}\n` : "\n";
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeTextBlockWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|table|tr|ul|ol|blockquote|pre)>/gi, "\n");

  return normalizeTextBlockWhitespace(stripInvisibleUnicode(stripTags(text)));
}

function readMetaContent(
  document: HtmlDocument,
  selectors: readonly string[],
): string | undefined {
  for (const selector of selectors) {
    const content = trimToUndefined(document.querySelector(selector)?.getAttribute("content"));
    if (content) {
      return content;
    }
  }

  return undefined;
}

function readPageMetadata(document: HtmlDocument, url: string): PageMetadata {
  const canonicalHref = trimToUndefined(document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
  return {
    title: trimToUndefined(document.querySelector("title")?.textContent ?? undefined),
    description: readMetaContent(document, [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
    ]),
    siteName:
      readMetaContent(document, [
        'meta[property="og:site_name"]',
        'meta[name="application-name"]',
      ]) ?? trimToUndefined(new URL(url).hostname),
    canonicalUrl: canonicalHref ? absolutizeUrl(canonicalHref, url) ?? undefined : undefined,
  };
}

function shouldRemoveElement(element: HtmlElementLike): boolean {
  const tagName = element.tagName.toLowerCase();
  if ([
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "canvas",
    "svg",
    "object",
    "embed",
  ].includes(tagName)) {
    return true;
  }

  if (element.hasAttribute("hidden")) {
    return true;
  }
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }

  const classNames = (element.getAttribute("class") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (classNames.some((className) => HIDDEN_CLASS_NAMES.has(className))) {
    return true;
  }

  const style = (element.getAttribute("style") ?? "").toLowerCase();
  return style.includes("display:none")
    || style.includes("visibility:hidden")
    || style.includes("opacity:0")
    || style.includes("font-size:0");
}

function sanitizeHtml(html: string): string {
  const strippedComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const {document} = parseHTML(strippedComments);
  const allElements = Array.from(document.querySelectorAll("*")) as HtmlElementLike[];
  for (let index = allElements.length - 1; index >= 0; index -= 1) {
    const element = allElements[index];
    if (!element) {
      continue;
    }
    if (shouldRemoveElement(element)) {
      element.remove();
    }
  }

  return String(document);
}

function extractLinks(html: string, baseUrl: string): readonly WebFetchLink[] {
  const {document} = parseHTML(`<html><body>${html}</body></html>`);
  const links: WebFetchLink[] = [];
  const seen = new Set<string>();

  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = trimToUndefined(anchor.getAttribute("href"));
    if (!href) {
      continue;
    }

    const absolute = absolutizeUrl(href, baseUrl);
    if (!absolute || seen.has(absolute)) {
      continue;
    }

    const text = normalizeTextBlockWhitespace(stripInvisibleUnicode(anchor.textContent ?? "")) || absolute;
    seen.add(absolute);
    links.push({text, url: absolute});
    if (links.length >= 20) {
      break;
    }
  }

  return links;
}

/** Extracts stable readable text and links from HTML without trusting scripts, hidden content, or raw markup. */
export function extractReadableContentFromHtml(params: {
  html: string;
  url: string;
}): ReadableWebContent {
  const sanitizedHtml = sanitizeHtml(params.html);
  const metadataDocument = parseHTML(sanitizedHtml).document;
  const metadata = readPageMetadata(metadataDocument, params.url);
  const fallbackHtml = metadataDocument.body?.innerHTML ?? sanitizedHtml;

  let readableHtml = fallbackHtml;
  let readableTitle = metadata.title;
  let readableDescription = metadata.description;
  let readableSiteName = metadata.siteName;

  if (sanitizedHtml.length <= MAX_HTML_CHARS_FOR_READABILITY) {
    const {document} = parseHTML(sanitizedHtml);
    try {
      (document as {baseURI?: string}).baseURI = params.url;
    } catch {
      // Best effort for relative links inside readability output.
    }

    const article = new Readability(document, {charThreshold: 0}).parse();
    if (article?.content) {
      readableHtml = article.content;
      readableTitle = trimToUndefined(article.title) ?? readableTitle;
      readableDescription = trimToUndefined(article.excerpt) ?? readableDescription;
      readableSiteName = trimToUndefined(article.siteName) ?? readableSiteName;
    }
  }

  const content = htmlToMarkdown(readableHtml, params.url);
  if (!content) {
    throw new ToolError("web.fetch could not extract any readable content from the page.");
  }

  return {
    title: readableTitle,
    description: readableDescription,
    siteName: readableSiteName,
    canonicalUrl: metadata.canonicalUrl,
    content,
    links: extractLinks(readableHtml, params.url),
  };
}
