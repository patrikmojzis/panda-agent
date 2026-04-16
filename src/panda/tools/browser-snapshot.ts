import {ToolError} from "../../kernel/agent/exceptions.js";
import {wrapBrowserExternalContent} from "./browser-output.js";
import type {
    BrowserPageSignal,
    BrowserSnapshot,
    BrowserSnapshotChanges,
    BrowserSnapshotElement,
    BrowserSnapshotMode,
} from "./browser-types.js";

export const SNAPSHOT_REF_ATTRIBUTE = "data-runtime-ref";

export type SnapshotScriptResult = {
  url: string;
  title: string;
  text: string;
  pageText: string;
  dialogText: string;
  signals: BrowserPageSignal[];
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type?: string;
    disabled?: boolean;
    value?: string;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
    pressed?: boolean;
    required?: boolean;
    invalid?: boolean;
    readonly?: boolean;
    href?: string;
    section?: "page" | "dialog";
  }>;
};

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
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
  if (element.section === "dialog") {
    parts.push("[dialog]");
  }
  if (element.text) {
    parts.push(`"${element.text}"`);
  }
  if (element.value) {
    parts.push(`value="${element.value}"`);
  }
  if (element.href) {
    parts.push(`-> ${element.href}`);
  }
  if (element.disabled) {
    parts.push("[disabled]");
  }
  if (element.checked !== undefined) {
    parts.push(element.checked ? "[checked]" : "[unchecked]");
  }
  if (element.selected !== undefined) {
    parts.push(element.selected ? "[selected]" : "[unselected]");
  }
  if (element.expanded !== undefined) {
    parts.push(element.expanded ? "[expanded]" : "[collapsed]");
  }
  if (element.pressed !== undefined) {
    parts.push(element.pressed ? "[pressed]" : "[not-pressed]");
  }
  if (element.required) {
    parts.push("[required]");
  }
  if (element.invalid) {
    parts.push("[invalid]");
  }
  if (element.readonly) {
    parts.push("[readonly]");
  }
  return parts.join(" ");
}

function formatTargetChange(changes: BrowserSnapshotChanges): string | null {
  const target = changes.target;
  if (!target || !target.changed || target.changed.length === 0) {
    return null;
  }
  const label = target.ref
    ? `Target ${target.ref}`
    : target.selector
      ? `Target ${target.selector}`
      : "Target";
  const before = target.before?.trim();
  const after = target.after?.trim();
  const state = target.changed.join(", ");
  if (before || after) {
    return `${label} changed: ${state} (${before ?? "(empty)"} -> ${after ?? "(empty)"})`;
  }
  return `${label} changed: ${state}`;
}

function renderChangesBlock(changes: BrowserSnapshotChanges | null | undefined): string[] {
  if (!changes) {
    return [];
  }

  const lines: string[] = [];
  if (changes.pageSwitched) {
    lines.push("- Switched to a new page");
  }
  if (changes.urlChanged) {
    lines.push(`- URL changed: ${changes.urlChanged.before} -> ${changes.urlChanged.after}`);
  }
  if (changes.titleChanged) {
    lines.push(
      `- Title changed: ${changes.titleChanged.before ?? "(none)"} -> ${changes.titleChanged.after ?? "(none)"}`,
    );
  }
  if (changes.dialogAppeared) {
    lines.push("- Dialog appeared");
  }
  if (changes.dialogDismissed) {
    lines.push("- Dialog closed");
  }
  if (changes.signalsAdded && changes.signalsAdded.length > 0) {
    lines.push(`- Signals added: ${changes.signalsAdded.join(", ")}`);
  }
  if (changes.signalsRemoved && changes.signalsRemoved.length > 0) {
    lines.push(`- Signals removed: ${changes.signalsRemoved.join(", ")}`);
  }
  const targetChange = formatTargetChange(changes);
  if (targetChange) {
    lines.push(`- ${targetChange}`);
  }
  return lines;
}

function buildExternalSnapshotBody(
  snapshot: BrowserSnapshot,
  mode: BrowserSnapshotMode,
  maxChars: number,
): {text: string; truncated: boolean} {
  const elementLines = snapshot.elements.length > 0
    ? ["Interactive elements:", ...snapshot.elements.map((element) => renderElementLine(element))]
    : ["Interactive elements: none"];
  const elementBlock = elementLines.join("\n");
  const reservedTextBudget = Math.max(240, maxChars - elementBlock.length - 240);
  const dialogWeight = snapshot.dialogText ? (mode === "full" ? 0.35 : 0.5) : 0;
  const dialogBudget = snapshot.dialogText ? Math.max(120, Math.floor(reservedTextBudget * dialogWeight)) : 0;
  const pageBudget = Math.max(120, reservedTextBudget - dialogBudget);
  const dialogText = truncateText(normalizeWhitespace(snapshot.dialogText), dialogBudget);
  const pageText = truncateText(normalizeWhitespace(snapshot.pageText), pageBudget);
  const parts: string[] = [];

  if (dialogText.text) {
    parts.push("Dialog / overlay text:");
    parts.push(dialogText.text);
  }
  if (pageText.text) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(mode === "full" ? "Visible page text:" : "Visible page summary:");
    parts.push(pageText.text);
  }
  if (parts.length > 0) {
    parts.push("");
  }
  parts.push(elementBlock);

  const text = parts.join("\n").trim();
  return {
    text,
    truncated: dialogText.truncated || pageText.truncated,
  };
}

export function renderBrowserSnapshot(
  snapshot: BrowserSnapshot,
  params: {
    maxChars: number;
    mode: BrowserSnapshotMode;
    changes?: BrowserSnapshotChanges | null;
  },
): {text: string; truncated: boolean} {
  const preamble = [
    snapshot.title ? `# ${snapshot.title}` : "# Browser Page",
    `URL: ${snapshot.url}`,
    ...(snapshot.signals.length > 0 ? [`Signals: ${snapshot.signals.join(", ")}`] : []),
  ];
  const changeLines = renderChangesBlock(params.changes);
  if (changeLines.length > 0) {
    preamble.push("Changes:");
    preamble.push(...changeLines);
  }

  let bodyBudget = Math.max(400, params.maxChars - preamble.join("\n").length - 120);
  let body = buildExternalSnapshotBody(snapshot, params.mode, bodyBudget);
  let text = [
    ...preamble,
    "",
    wrapBrowserExternalContent(body.text, {kind: "snapshot"}),
  ].join("\n").trim();

  if (text.length > params.maxChars) {
    bodyBudget = Math.max(240, bodyBudget - (text.length - params.maxChars) - 40);
    body = buildExternalSnapshotBody(snapshot, params.mode, bodyBudget);
    text = [
      ...preamble,
      "",
      wrapBrowserExternalContent(body.text, {kind: "snapshot"}),
    ].join("\n").trim();
  }

  return {
    text,
    truncated: body.truncated,
  };
}

export function getSnapshotScript(): string {
  return String.raw`
    const root = globalThis;
    const refAttribute = "data-runtime-ref";
    const maxElements = 200;
    const safeMaxChars = typeof maxChars === "number" && Number.isFinite(maxChars) ? maxChars : 20000;
    const dialogSelector = "dialog,[role='dialog'],[role='alertdialog'],[aria-modal='true']";
    const alertSelector = "[role='alert'],[role='alertdialog'],[aria-live='assertive']";

    const normalize = (value) => String(value ?? "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const truncateValue = (value, length) => {
      const normalized = normalize(value);
      if (!normalized) {
        return "";
      }
      return normalized.length <= length ? normalized : normalized.slice(0, length).trimEnd();
    };
    const readBoolean = (value) => {
      if (value === true || value === "true") {
        return true;
      }
      if (value === false || value === "false") {
        return false;
      }
      return undefined;
    };

    const isVisible = (element) => {
      if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = root.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0" ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const labelFromIds = (element, attr) => {
      const ids = normalize(attr).split(/\s+/).filter(Boolean);
      if (ids.length === 0) {
        return "";
      }
      return truncateValue(
        ids
          .map((id) => root.document.getElementById(id)?.textContent ?? "")
          .join(" "),
        240,
      );
    };

    const getImplicitRole = (element, tag, type) => {
      if (tag === "a" && element.getAttribute("href")) {
        return "link";
      }
      if (tag === "button" || tag === "summary") {
        return "button";
      }
      if (tag === "select") {
        return "combobox";
      }
      if (tag === "textarea") {
        return "textbox";
      }
      if (tag === "input") {
        if (type === "checkbox") {
          return "checkbox";
        }
        if (type === "radio") {
          return "radio";
        }
        if (["button", "submit", "reset", "image"].includes(type)) {
          return "button";
        }
        return "textbox";
      }
      if (element.getAttribute("contenteditable") === "true") {
        return "textbox";
      }
      return tag || "element";
    };

    const describeValue = (element, tag, type) => {
      if (tag === "select") {
        return truncateValue(
          Array.from(element.selectedOptions ?? [])
            .map((option) => option.textContent ?? "")
            .join(", "),
          160,
        );
      }
      if (tag === "textarea") {
        return truncateValue(element.value, 160);
      }
      if (tag === "input") {
        if (["hidden", "password", "checkbox", "radio", "button", "submit", "reset", "file", "image"].includes(type)) {
          return "";
        }
        return truncateValue(element.value, 160);
      }
      return "";
    };

    const describeText = (element, tag, type) => {
      return truncateValue(
        element.getAttribute("aria-label") ||
        labelFromIds(element, element.getAttribute("aria-labelledby")) ||
        Array.from(element.labels ?? [])
          .map((label) => label.textContent ?? "")
          .join(" ") ||
        element.placeholder ||
        (tag === "select"
          ? Array.from(element.selectedOptions ?? [])
            .map((option) => option.textContent ?? "")
            .join(", ")
          : "") ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        (tag === "input" && !["password", "hidden", "checkbox", "radio"].includes(type) ? element.value : "") ||
        element.textContent,
        240,
      );
    };

    const isDialogElement = (element) => Boolean(element.closest(dialogSelector));

    const describeElement = (element) => {
      const tag = normalize(element.tagName).toLowerCase();
      const type = tag === "input" ? normalize(element.getAttribute("type")) : undefined;
      const role = normalize(element.getAttribute("role")) || getImplicitRole(element, tag, type);
      const text = describeText(element, tag, type);
      const value = describeValue(element, tag, type);
      const rect = element.getBoundingClientRect();
      const invalidByConstraint =
        typeof element.checkValidity === "function"
          ? !element.checkValidity()
          : undefined;

      return {
        tag,
        role,
        text,
        ...(type ? { type } : {}),
        ...(element.disabled !== undefined ? { disabled: Boolean(element.disabled) } : {}),
        ...(value ? { value } : {}),
        ...((type === "checkbox" || type === "radio") ? { checked: Boolean(element.checked) } : {}),
        ...(tag === "select" ? { selected: (element.selectedOptions?.length ?? 0) > 0 } : {}),
        ...(readBoolean(element.getAttribute("aria-expanded")) !== undefined
          ? { expanded: readBoolean(element.getAttribute("aria-expanded")) }
          : {}),
        ...(readBoolean(element.getAttribute("aria-pressed")) !== undefined
          ? { pressed: readBoolean(element.getAttribute("aria-pressed")) }
          : {}),
        ...((element.required === true || element.getAttribute("aria-required") === "true")
          ? { required: true }
          : {}),
        ...((element.getAttribute("aria-invalid") === "true" || invalidByConstraint === true)
          ? { invalid: true }
          : {}),
        ...((element.readOnly === true || element.getAttribute("aria-readonly") === "true")
          ? { readonly: true }
          : {}),
        ...(tag === "a" && element.href ? { href: element.href } : {}),
        ...(isDialogElement(element) ? { section: "dialog" } : { section: "page" }),
        __top: rect.top,
        __left: rect.left,
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

    const dialogRoots = Array.from(root.document.querySelectorAll(dialogSelector))
      .filter((element) => isVisible(element));

    const dialogText = truncateValue(
      dialogRoots.map((element) => element.innerText || element.textContent || "").join("\n\n"),
      Math.max(safeMaxChars * 2, safeMaxChars),
    );
    const combinedText = truncateValue(
      root.document.body?.innerText ?? "",
      Math.max(safeMaxChars * 3, safeMaxChars),
    );
    const pageText = dialogText && combinedText.includes(dialogText)
      ? truncateValue(combinedText.replace(dialogText, " "), Math.max(safeMaxChars * 2, safeMaxChars))
      : combinedText;

    const elements = Array.from(root.document.querySelectorAll(interactiveSelector))
      .filter((element) => isVisible(element))
      .map((element) => {
        const description = describeElement(element);
        return {
          node: element,
          description,
        };
      })
      .sort((left, right) => {
        if (left.description.__top !== right.description.__top) {
          return left.description.__top - right.description.__top;
        }
        return left.description.__left - right.description.__left;
      })
      .slice(0, maxElements)
      .map((entry, index) => {
        const ref = "e" + (index + 1);
        entry.node.setAttribute(refAttribute, ref);
        return {
          ...entry.description,
          ref,
        };
      });

    const signals = [];
    if (dialogRoots.length > 0) {
      signals.push("dialog");
    }
    if (Array.from(root.document.querySelectorAll(alertSelector)).some((element) => isVisible(element))) {
      signals.push("alert");
    }
    if (
      Array.from(root.document.querySelectorAll("input, textarea, select")).some((element) => {
        if (!isVisible(element)) {
          return false;
        }
        if (element.getAttribute("aria-invalid") === "true") {
          return true;
        }
        return typeof element.checkValidity === "function" ? !element.checkValidity() : false;
      })
    ) {
      signals.push("validation_error");
    }
    if (Array.from(root.document.querySelectorAll("input[type='password']")).some((element) => isVisible(element))) {
      signals.push("login");
    }
    if (
      /captcha|recaptcha|hcaptcha|verify you are human|i'?m not a robot/i.test(combinedText) ||
      Array.from(root.document.querySelectorAll("iframe, [id], [class], [data-sitekey], [name]")).some((element) => {
        if (!isVisible(element)) {
          return false;
        }
        const haystack = [
          element.getAttribute("src"),
          element.getAttribute("id"),
          element.getAttribute("class"),
          element.getAttribute("name"),
          element.getAttribute("data-sitekey"),
          element.getAttribute("title"),
        ].join(" ");
        return /captcha|recaptcha|hcaptcha/i.test(haystack);
      })
    ) {
      signals.push("captcha");
    }

    return {
      url: root.location.href,
      title: normalize(root.document.title),
      text: combinedText,
      pageText,
      dialogText,
      signals: Array.from(new Set(signals)),
      elements: elements.map((element) => {
        const cleaned = { ...element };
        delete cleaned.__top;
        delete cleaned.__left;
        return cleaned;
      }),
    };
  `;
}

export function normalizeSnapshotResult(
  value: SnapshotScriptResult,
  params: {
    maxChars: number;
    mode: BrowserSnapshotMode;
    changes?: BrowserSnapshotChanges | null;
  },
): {snapshot: BrowserSnapshot; truncated: boolean; text: string} {
  const snapshot: BrowserSnapshot = {
    url: normalizeWhitespace(value.url),
    title: normalizeWhitespace(value.title),
    text: normalizeWhitespace(value.text),
    pageText: normalizeWhitespace(value.pageText),
    dialogText: normalizeWhitespace(value.dialogText),
    signals: value.signals.map((signal) => signal) as BrowserPageSignal[],
    elements: value.elements.map((element) => ({
      ref: normalizeWhitespace(element.ref),
      tag: normalizeWhitespace(element.tag),
      role: normalizeWhitespace(element.role),
      text: normalizeWhitespace(element.text),
      ...(element.type ? {type: normalizeWhitespace(element.type)} : {}),
      ...(element.disabled !== undefined ? {disabled: element.disabled} : {}),
      ...(element.value ? {value: normalizeWhitespace(element.value)} : {}),
      ...(element.checked !== undefined ? {checked: element.checked} : {}),
      ...(element.selected !== undefined ? {selected: element.selected} : {}),
      ...(element.expanded !== undefined ? {expanded: element.expanded} : {}),
      ...(element.pressed !== undefined ? {pressed: element.pressed} : {}),
      ...(element.required !== undefined ? {required: element.required} : {}),
      ...(element.invalid !== undefined ? {invalid: element.invalid} : {}),
      ...(element.readonly !== undefined ? {readonly: element.readonly} : {}),
      ...(element.href ? {href: normalizeWhitespace(element.href)} : {}),
      ...(element.section ? {section: element.section} : {}),
    })),
  };
  const rendered = renderBrowserSnapshot(snapshot, params);
  return {
    snapshot,
    truncated: rendered.truncated,
    text: rendered.text,
  };
}
