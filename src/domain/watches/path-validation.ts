import type {WatchJsonResultConfig, WatchRowResultConfig, WatchSourceConfig,} from "./types.js";

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }

  return trimmed;
}

const NEGATIVE_ARRAY_INDEX_PATTERN = /\[-\d+\]/;

export function validateWatchPath(path: string, field: string): string {
  const normalized = requireTrimmed(field, path);
  if (NEGATIVE_ARRAY_INDEX_PATTERN.test(normalized)) {
    throw new Error(`Negative array indices are not supported in ${field} "${normalized}". Sort/filter upstream and use [0].`);
  }

  return normalized;
}

function validateRowResultPaths(result: WatchRowResultConfig, fieldPrefix: string): void {
  if (result.observation === "collection") {
    validateWatchPath(result.itemIdField, `${fieldPrefix}.itemIdField`);
    validateWatchPath(result.itemCursorField, `${fieldPrefix}.itemCursorField`);
    if (result.summaryField) {
      validateWatchPath(result.summaryField, `${fieldPrefix}.summaryField`);
    }
    for (const [index, field] of (result.fields ?? []).entries()) {
      validateWatchPath(field, `${fieldPrefix}.fields[${index}]`);
    }
    return;
  }

  validateWatchPath(result.valueField, `${fieldPrefix}.valueField`);
}

function validateJsonResultPaths(result: WatchJsonResultConfig, fieldPrefix: string): void {
  switch (result.observation) {
    case "collection":
      if (result.itemsPath) {
        validateWatchPath(result.itemsPath, `${fieldPrefix}.itemsPath`);
      }
      validateWatchPath(result.itemIdPath, `${fieldPrefix}.itemIdPath`);
      validateWatchPath(result.itemCursorPath, `${fieldPrefix}.itemCursorPath`);
      if (result.summaryPath) {
        validateWatchPath(result.summaryPath, `${fieldPrefix}.summaryPath`);
      }
      for (const [field, path] of Object.entries(result.fieldPaths ?? {})) {
        validateWatchPath(path, `${fieldPrefix}.fieldPaths.${field}`);
      }
      return;
    case "scalar":
      validateWatchPath(result.valuePath, `${fieldPrefix}.valuePath`);
      return;
    case "snapshot":
      if (result.path) {
        validateWatchPath(result.path, `${fieldPrefix}.path`);
      }
      return;
  }
}

export function validateWatchSourcePaths(source: WatchSourceConfig): void {
  switch (source.kind) {
    case "mongodb_query":
    case "sql_query":
      validateRowResultPaths(source.result, "source.result");
      return;
    case "http_json":
      validateJsonResultPaths(source.result, "source.result");
      return;
    case "http_html":
    case "imap_mailbox":
      return;
  }
}
