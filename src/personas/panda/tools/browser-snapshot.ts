import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {BrowserSnapshot, BrowserSnapshotElement} from "./browser-types.js";

const SNAPSHOT_REF_ATTRIBUTE = "data-panda-ref";

export type SnapshotScriptResult = {
  url: string;
  title: string;
  text: string;
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type?: string;
    disabled?: boolean;
  }>;
};

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function truncateText(value: string, maxChars: number): {text: string; truncated: boolean} {
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false,
    };
  }

  return {
    text: value.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

export function buildRefSelector(ref: string): string {
  if (!/^e\d+$/.test(ref)) {
    throw new ToolError(`browser ref must look like e1 or e12 (got ${ref}).`);
  }
  return `[${SNAPSHOT_REF_ATTRIBUTE}="${ref}"]`;
}

function renderElementLine(element: BrowserSnapshotElement): string {
  const parts = [`- [${element.ref}]`, element.role];
  if (element.type && element.type !== element.tag) {
    parts.push(`(${element.type})`);
  }
  if (element.text) {
    parts.push(`"${element.text}"`);
  }
  if (element.disabled) {
    parts.push("[disabled]");
  }
  return parts.join(" ");
}

export function renderBrowserSnapshot(
  snapshot: BrowserSnapshot,
  maxChars: number,
): {text: string; truncated: boolean} {
  const truncatedText = truncateText(normalizeWhitespace(snapshot.text), maxChars);
  const lines = [
    snapshot.title ? `# ${snapshot.title}` : "# Browser Page",
    `URL: ${snapshot.url}`,
    "",
  ];

  if (truncatedText.text) {
    lines.push(truncatedText.text);
    lines.push("");
  }

  if (snapshot.elements.length > 0) {
    lines.push("Interactive elements:");
    for (const element of snapshot.elements) {
      lines.push(renderElementLine(element));
    }
  } else {
    lines.push("Interactive elements: none");
  }

  if (truncatedText.truncated) {
    lines.push("");
    lines.push("[... snapshot text truncated ...]");
  }

  return {
    text: lines.join("\n").trim(),
    truncated: truncatedText.truncated,
  };
}

export function getSnapshotScript(): string {
  return String.raw`
    const root = globalThis;
    const refAttribute = "data-panda-ref";
    const maxElements = 200;
    const safeMaxChars = typeof maxChars === "number" && Number.isFinite(maxChars) ? maxChars : 20000;

    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

    const isVisible = (element) => {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = root.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const describeElement = (element) => {
      const tag = normalize(element.tagName).toLowerCase();
      const type = tag === "input" ? normalize(element.getAttribute("type")) : undefined;
      const role = normalize(element.getAttribute("role")) || tag || "element";
      const text = normalize(
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.value ||
        element.placeholder ||
        element.selectedOptions?.[0]?.textContent ||
        element.getAttribute("alt") ||
        element.textContent
      ).slice(0, 240);
      return {
        tag,
        role,
        text,
        ...(type ? { type } : {}),
        ...(element.disabled !== undefined ? { disabled: Boolean(element.disabled) } : {}),
      };
    };

    for (const previous of Array.from(root.document.querySelectorAll("[" + refAttribute + "]"))) {
      previous.removeAttribute(refAttribute);
    }

    const interactiveSelector = [
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "summary",
      "[contenteditable='true']",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='switch']",
      "[tabindex]",
    ].join(",");

    const elements = Array.from(root.document.querySelectorAll(interactiveSelector))
      .filter((element) => isVisible(element))
      .slice(0, maxElements)
      .map((element, index) => {
        const ref = "e" + (index + 1);
        element.setAttribute(refAttribute, ref);
        return {
          ref,
          ...describeElement(element),
        };
      });

    const text = normalize(root.document.body?.innerText ?? "").slice(0, Math.max(safeMaxChars * 2, safeMaxChars));

    return {
      url: root.location.href,
      title: normalize(root.document.title),
      text,
      elements,
    };
  `;
}

export function normalizeSnapshotResult(
  value: SnapshotScriptResult,
  maxChars: number,
): {snapshot: BrowserSnapshot; truncated: boolean; text: string} {
  const snapshot: BrowserSnapshot = {
    url: normalizeWhitespace(value.url),
    title: normalizeWhitespace(value.title),
    text: normalizeWhitespace(value.text),
    elements: value.elements.map((element) => ({
      ref: normalizeWhitespace(element.ref),
      tag: normalizeWhitespace(element.tag),
      role: normalizeWhitespace(element.role),
      text: normalizeWhitespace(element.text),
      ...(element.type ? {type: normalizeWhitespace(element.type)} : {}),
      ...(element.disabled !== undefined ? {disabled: element.disabled} : {}),
    })),
  };
  const rendered = renderBrowserSnapshot(snapshot, maxChars);
  return {
    snapshot,
    truncated: rendered.truncated,
    text: rendered.text,
  };
}
