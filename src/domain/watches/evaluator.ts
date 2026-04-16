import {createHash} from "node:crypto";

import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import type {
    WatchCollectionItem,
    WatchCollectionObservation,
    WatchCursorValue,
    WatchEvaluationResult,
    WatchEventDraft,
    WatchRecord,
    WatchScalarObservation,
    WatchSnapshotObservation,
    WatchSourceEvaluation,
} from "./types.js";

interface NewItemsState {
  kind: "new_items";
  identityToken?: string;
  bootstrapped: boolean;
  lastCursor?: WatchCursorValue;
  lastIds: string[];
}

interface SnapshotState {
  kind: "snapshot_changed";
  identityToken?: string;
  fingerprint: string;
  excerpt: string;
}

interface PercentChangeState {
  kind: "percent_change";
  identityToken?: string;
  baseline: number;
  lastValue: number;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

function hashValue(value: JsonValue | string): string {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

function compareCursorValues(left: WatchCursorValue, right: WatchCursorValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) {
    return 0;
  }

  return leftText < rightText ? -1 : 1;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trimEnd();
}

function withIdentityToken<T extends JsonObject>(value: T, identityToken?: string): T & JsonObject {
  if (identityToken === undefined) {
    return value;
  }

  return {
    ...value,
    identityToken,
  };
}

function asStateObject(value: NewItemsState | SnapshotState | PercentChangeState): JsonObject {
  return value as unknown as JsonObject;
}

function buildCollectionState(
  items: readonly WatchCollectionItem[],
  identityToken?: string,
): NewItemsState {
  if (items.length === 0) {
    return withIdentityToken({
      kind: "new_items",
      bootstrapped: true,
      lastIds: [],
    }, identityToken) as NewItemsState;
  }

  const latestCursor = items[items.length - 1]!.cursor;
  const lastIds = items
    .filter((item) => compareCursorValues(item.cursor, latestCursor) === 0)
    .map((item) => item.id);

  return withIdentityToken({
    kind: "new_items",
    bootstrapped: true,
    lastCursor: latestCursor,
    lastIds,
  }, identityToken) as NewItemsState;
}

function formatPercentChange(value: number): string {
  const formatted = Math.abs(value).toFixed(2);
  return `${value >= 0 ? "+" : "-"}${formatted}%`;
}

function buildNewItemsEvent(items: readonly WatchCollectionItem[], maxItems: number): WatchEventDraft {
  const visibleItems = items.slice(-maxItems).reverse();
  const payloadItems = visibleItems.map((item) => {
    const normalized: JsonObject = {
      id: item.id,
      cursor: item.cursor,
    };
    if (item.summary) {
      normalized.summary = item.summary;
    }
    if (item.data) {
      normalized.data = item.data;
    }
    return normalized;
  });

  return {
    eventKind: "new_items",
    summary: `Detected ${items.length} new item${items.length === 1 ? "" : "s"}.`,
    dedupeKey: hashValue({
      kind: "new_items",
      ids: items.map((item) => item.id),
      lastCursor: items.at(-1)?.cursor ?? null,
    }),
    payload: {
      totalNewItems: items.length,
      items: payloadItems,
    },
  };
}

function evaluateNewItems(
  observation: WatchCollectionObservation,
  detector: WatchRecord["detector"] & {kind: "new_items"},
  previousState: JsonObject | undefined,
  identityToken?: string,
): WatchEvaluationResult {
  const items = [...observation.items].sort((left, right) => {
    const cursorComparison = compareCursorValues(left.cursor, right.cursor);
    if (cursorComparison !== 0) {
      return cursorComparison;
    }

    return left.id.localeCompare(right.id);
  });
  const state = previousState as Partial<NewItemsState> | undefined;
  const identityChanged = state?.identityToken !== identityToken;
  const nextState = buildCollectionState(items, identityToken);

  if (!state?.bootstrapped || identityChanged) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  const lastIds = new Set(state.lastIds ?? []);
  let newItems: WatchCollectionItem[];
  if (state.lastCursor === undefined) {
    newItems = items;
  } else {
    newItems = items.filter((item) => {
      const comparison = compareCursorValues(item.cursor, state.lastCursor as WatchCursorValue);
      return comparison > 0 || (comparison === 0 && !lastIds.has(item.id));
    });
  }

  if (newItems.length === 0) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  return {
    changed: true,
    nextState: asStateObject(nextState),
    event: buildNewItemsEvent(newItems, Math.max(1, detector.maxItems ?? 10)),
  };
}

function evaluateSnapshotChanged(
  observation: WatchSnapshotObservation,
  detector: WatchRecord["detector"] & {kind: "snapshot_changed"},
  previousState: JsonObject | undefined,
  identityToken?: string,
): WatchEvaluationResult {
  const excerptChars = Math.max(40, detector.excerptChars ?? 240);
  const excerpt = truncateText(observation.text, excerptChars);
  const fingerprint = hashValue(observation.text);
  const state = previousState as Partial<SnapshotState> | undefined;
  const nextState = withIdentityToken({
    kind: "snapshot_changed",
    fingerprint,
    excerpt,
  }, identityToken) as SnapshotState;

  if (!state?.fingerprint || state.identityToken !== identityToken) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  if (state.fingerprint === fingerprint) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  return {
    changed: true,
    nextState: asStateObject(nextState),
    event: {
      eventKind: "snapshot_changed",
      summary: "Observed content changed.",
      dedupeKey: fingerprint,
      payload: {
        previousExcerpt: state.excerpt ?? "",
        currentExcerpt: excerpt,
        fingerprint,
      },
    },
  };
}

function evaluatePercentChange(
  observation: WatchScalarObservation,
  detector: WatchRecord["detector"] & {kind: "percent_change"},
  previousState: JsonObject | undefined,
  identityToken?: string,
): WatchEvaluationResult {
  const state = previousState as Partial<PercentChangeState> | undefined;
  const current = observation.value;

  if (!Number.isFinite(current)) {
    throw new Error("Scalar watch observations must be finite numbers.");
  }

  if (state?.baseline === undefined || state.identityToken !== identityToken) {
    return {
      changed: false,
      nextState: asStateObject(withIdentityToken({
        kind: "percent_change",
        baseline: current,
        lastValue: current,
      }, identityToken) as PercentChangeState),
    };
  }

  const baseline = state.baseline;
  const delta = current - baseline;
  const percentChange = baseline === 0
    ? (current === 0 ? 0 : Number.POSITIVE_INFINITY)
    : Math.abs((delta / baseline) * 100);
  const nextState = withIdentityToken({
    kind: "percent_change",
    baseline,
    lastValue: current,
  }, identityToken) as PercentChangeState;

  if (percentChange < detector.percent) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  return {
    changed: true,
    nextState: asStateObject(withIdentityToken({
      kind: "percent_change",
      baseline: current,
      lastValue: current,
    }, identityToken) as PercentChangeState),
    event: {
      eventKind: "percent_change",
      summary: `${observation.label ?? "Value"} moved ${formatPercentChange(delta === 0 ? 0 : (delta / Math.abs(baseline || current || 1)) * 100)} from baseline.`,
      dedupeKey: hashValue({
        kind: "percent_change",
        baseline,
        current,
        threshold: detector.percent,
      }),
      payload: {
        label: observation.label ?? null,
        baseline,
        current,
        delta,
        percentChange,
        thresholdPercent: detector.percent,
      },
    },
  };
}

export function evaluateWatchObservation(
  watch: WatchRecord,
  resolved: WatchSourceEvaluation,
): WatchEvaluationResult {
  switch (watch.detector.kind) {
    case "new_items":
      if (resolved.observation.kind !== "collection") {
        throw new Error(`Watch detector ${watch.detector.kind} requires a collection observation.`);
      }
      return evaluateNewItems(
        resolved.observation,
        watch.detector,
        watch.state,
        resolved.identityToken,
      );

    case "snapshot_changed":
      if (resolved.observation.kind !== "snapshot") {
        throw new Error(`Watch detector ${watch.detector.kind} requires a snapshot observation.`);
      }
      return evaluateSnapshotChanged(
        resolved.observation,
        watch.detector,
        watch.state,
        resolved.identityToken,
      );

    case "percent_change":
      if (resolved.observation.kind !== "scalar") {
        throw new Error(`Watch detector ${watch.detector.kind} requires a scalar observation.`);
      }
      return evaluatePercentChange(
        resolved.observation,
        watch.detector,
        watch.state,
        resolved.identityToken,
      );
  }
}
