import type {JsonObject} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {
    BrowserAction,
    BrowserSnapshot,
    BrowserSnapshotChanges,
    BrowserSnapshotElement,
} from "./action-types.js";

function summarizeSnapshotElement(element: BrowserSnapshotElement | undefined): string | undefined {
  if (!element) {
    return undefined;
  }

  const parts: string[] = [];
  if (element.text) {
    parts.push(`text="${element.text}"`);
  }
  if (element.value) {
    parts.push(`value="${element.value}"`);
  }
  if (element.checked !== undefined) {
    parts.push(element.checked ? "checked" : "unchecked");
  }
  if (element.selected !== undefined) {
    parts.push(element.selected ? "selected" : "unselected");
  }
  if (element.expanded !== undefined) {
    parts.push(element.expanded ? "expanded" : "collapsed");
  }
  if (element.pressed !== undefined) {
    parts.push(element.pressed ? "pressed" : "not-pressed");
  }
  if (element.invalid) {
    parts.push("invalid");
  }
  if (element.readonly) {
    parts.push("readonly");
  }
  if (element.href) {
    parts.push(`href="${element.href}"`);
  }
  if (parts.length === 0) {
    parts.push(element.role || element.tag || "element");
  }
  return parts.join(", ");
}

function diffSnapshotElementFields(
  before: BrowserSnapshotElement | undefined,
  after: BrowserSnapshotElement | undefined,
): readonly string[] {
  if (!before && !after) {
    return [];
  }
  if (!before) {
    return ["appeared"];
  }
  if (!after) {
    return ["disappeared"];
  }

  const changed: string[] = [];
  const fields: Array<keyof BrowserSnapshotElement> = [
    "text",
    "value",
    "checked",
    "selected",
    "expanded",
    "pressed",
    "disabled",
    "required",
    "invalid",
    "readonly",
    "href",
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      changed.push(field);
    }
  }
  return changed;
}

function resolveTargetSnapshotElement(
  snapshot: BrowserSnapshot,
  action: BrowserAction,
): BrowserSnapshotElement | undefined {
  if (!("ref" in action)) {
    return undefined;
  }
  const ref = trimToUndefined(action.ref);
  if (!ref) {
    return undefined;
  }
  return snapshot.elements.find((element) => element.ref === ref);
}

/** Compares compact browser snapshots into the action-focused delta shown to the model. */
export function buildSnapshotChanges(params: {
  before?: BrowserSnapshot | null;
  after: BrowserSnapshot;
  action: BrowserAction;
  pageSwitched: boolean;
}): BrowserSnapshotChanges | undefined {
  const before = params.before ?? null;
  const after = params.after;
  const changes: BrowserSnapshotChanges = {};

  if (params.pageSwitched) {
    changes.pageSwitched = true;
  }

  if (before && before.url !== after.url) {
    changes.urlChanged = {
      before: before.url,
      after: after.url,
    };
  }

  if (before && before.title !== after.title) {
    changes.titleChanged = {
      before: before.title,
      after: after.title,
    };
  }

  const beforeSignals = new Set(before?.signals ?? []);
  const afterSignals = new Set(after.signals);
  const signalsAdded = [...afterSignals].filter((signal) => !beforeSignals.has(signal));
  const signalsRemoved = [...beforeSignals].filter((signal) => !afterSignals.has(signal));
  if (signalsAdded.length > 0) {
    changes.signalsAdded = signalsAdded;
  }
  if (signalsRemoved.length > 0) {
    changes.signalsRemoved = signalsRemoved;
  }

  const beforeHasDialog = beforeSignals.has("dialog");
  const afterHasDialog = afterSignals.has("dialog");
  if (!beforeHasDialog && afterHasDialog) {
    changes.dialogAppeared = true;
  }
  if (beforeHasDialog && !afterHasDialog) {
    changes.dialogDismissed = true;
  }

  const beforeTarget = before ? resolveTargetSnapshotElement(before, params.action) : undefined;
  const afterTarget = resolveTargetSnapshotElement(after, params.action);
  const targetFieldChanges = diffSnapshotElementFields(beforeTarget, afterTarget);
  if (targetFieldChanges.length > 0) {
    const beforeSummary = summarizeSnapshotElement(beforeTarget);
    const afterSummary = summarizeSnapshotElement(afterTarget);
    changes.target = {
      ...("ref" in params.action && trimToUndefined(params.action.ref)
        ? {ref: params.action.ref?.trim()}
        : {}),
      ...("selector" in params.action && trimToUndefined(params.action.selector)
        ? {selector: params.action.selector?.trim()}
        : {}),
      ...(beforeSummary ? {before: beforeSummary} : {}),
      ...(afterSummary ? {after: afterSummary} : {}),
      changed: targetFieldChanges,
    };
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

export function toJsonSnapshotChanges(changes: BrowserSnapshotChanges): JsonObject {
  return {
    ...(changes.pageSwitched ? {pageSwitched: true} : {}),
    ...(changes.urlChanged
      ? {
          urlChanged: {
            before: changes.urlChanged.before,
            after: changes.urlChanged.after,
          },
        }
      : {}),
    ...(changes.titleChanged
      ? {
          titleChanged: {
            ...(changes.titleChanged.before !== undefined ? {before: changes.titleChanged.before} : {}),
            ...(changes.titleChanged.after !== undefined ? {after: changes.titleChanged.after} : {}),
          },
        }
      : {}),
    ...(changes.dialogAppeared ? {dialogAppeared: true} : {}),
    ...(changes.dialogDismissed ? {dialogDismissed: true} : {}),
    ...(changes.signalsAdded ? {signalsAdded: [...changes.signalsAdded]} : {}),
    ...(changes.signalsRemoved ? {signalsRemoved: [...changes.signalsRemoved]} : {}),
    ...(changes.target
      ? {
          target: {
            ...(changes.target.ref ? {ref: changes.target.ref} : {}),
            ...(changes.target.selector ? {selector: changes.target.selector} : {}),
            ...(changes.target.before !== undefined ? {before: changes.target.before} : {}),
            ...(changes.target.after !== undefined ? {after: changes.target.after} : {}),
            ...(changes.target.changed ? {changed: [...changes.target.changed]} : {}),
          },
        }
      : {}),
  };
}
