import type {JsonObject, JsonPrimitive, JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";

export type WatchRunStatus = "claimed" | "running" | "no_change" | "changed" | "failed" | "disabled";
export type WatchSourceKind = "mongodb_query" | "sql_query" | "http_json" | "http_html" | "imap_mailbox";
export type WatchObservationKind = "collection" | "snapshot" | "scalar";
export type WatchEventKind = "new_items" | "snapshot_changed" | "percent_change";
export type WatchCursorValue = string | number;

export interface WatchCollectionFieldPathMap {
  [field: string]: string;
}

export interface WatchHtmlFieldSelector {
  selector: string;
  attribute?: string;
}

export interface WatchRowCollectionResult {
  observation: "collection";
  itemIdField: string;
  itemCursorField: string;
  summaryField?: string;
  fields?: readonly string[];
}

export interface WatchRowScalarResult {
  observation: "scalar";
  valueField: string;
  label?: string;
}

export type WatchRowResultConfig =
  | WatchRowCollectionResult
  | WatchRowScalarResult;

export interface WatchJsonCollectionResult {
  observation: "collection";
  itemsPath?: string;
  itemIdPath: string;
  itemCursorPath: string;
  summaryPath?: string;
  fieldPaths?: WatchCollectionFieldPathMap;
}

export interface WatchJsonScalarResult {
  observation: "scalar";
  valuePath: string;
  label?: string;
}

export interface WatchJsonSnapshotResult {
  observation: "snapshot";
  path?: string;
}

export type WatchJsonResultConfig =
  | WatchJsonCollectionResult
  | WatchJsonScalarResult
  | WatchJsonSnapshotResult;

export interface WatchHtmlCollectionResult {
  observation: "collection";
  itemSelector: string;
  itemId: WatchHtmlFieldSelector;
  itemCursor: WatchHtmlFieldSelector;
  summary?: WatchHtmlFieldSelector;
  fields?: Record<string, WatchHtmlFieldSelector>;
}

export interface WatchHtmlSnapshotResult {
  observation: "snapshot";
  mode: "readable_text" | "selector_text";
  selector?: string;
}

export type WatchHtmlResultConfig =
  | WatchHtmlCollectionResult
  | WatchHtmlSnapshotResult;

export interface WatchRequestHeaderConfig {
  name: string;
  value?: string;
  credentialEnvKey?: string;
}

export interface WatchHttpBearerAuthConfig {
  type: "bearer";
  credentialEnvKey: string;
}

export interface WatchMongoDbFindSourceConfig {
  kind: "mongodb_query";
  credentialEnvKey: string;
  database: string;
  collection: string;
  operation: "find";
  filter?: JsonValue;
  projection?: JsonValue;
  sort?: JsonValue;
  limit?: number;
  result: WatchRowResultConfig;
}

export interface WatchMongoDbAggregateSourceConfig {
  kind: "mongodb_query";
  credentialEnvKey: string;
  database: string;
  collection: string;
  operation: "aggregate";
  pipeline: JsonValue;
  limit?: number;
  result: WatchRowResultConfig;
}

export type WatchMongoDbSourceConfig =
  | WatchMongoDbFindSourceConfig
  | WatchMongoDbAggregateSourceConfig;

export interface WatchSqlQuerySourceConfig {
  kind: "sql_query";
  credentialEnvKey: string;
  dialect: "postgres" | "mysql";
  query: string;
  parameters?: readonly JsonPrimitive[];
  result: WatchRowResultConfig;
}

export interface WatchHttpJsonSourceConfig {
  kind: "http_json";
  url: string;
  method?: "GET" | "POST";
  headers?: readonly WatchRequestHeaderConfig[];
  auth?: WatchHttpBearerAuthConfig;
  body?: string;
  result: WatchJsonResultConfig;
}

export interface WatchHttpHtmlSourceConfig {
  kind: "http_html";
  url: string;
  headers?: readonly WatchRequestHeaderConfig[];
  auth?: WatchHttpBearerAuthConfig;
  result: WatchHtmlResultConfig;
}

export interface WatchImapMailboxSourceConfig {
  kind: "imap_mailbox";
  host: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
  username?: string;
  usernameCredentialEnvKey?: string;
  passwordCredentialEnvKey: string;
  maxMessages?: number;
}

export type WatchSourceConfig =
  | WatchMongoDbSourceConfig
  | WatchSqlQuerySourceConfig
  | WatchHttpJsonSourceConfig
  | WatchHttpHtmlSourceConfig
  | WatchImapMailboxSourceConfig;

export interface WatchNewItemsDetectorConfig {
  kind: "new_items";
  maxItems?: number;
}

export interface WatchSnapshotChangedDetectorConfig {
  kind: "snapshot_changed";
  excerptChars?: number;
}

export interface WatchPercentChangeDetectorConfig {
  kind: "percent_change";
  percent: number;
}

export type WatchDetectorConfig =
  | WatchNewItemsDetectorConfig
  | WatchSnapshotChangedDetectorConfig
  | WatchPercentChangeDetectorConfig;

export interface WatchSpec {
  title: string;
  intervalMinutes: number;
  source: WatchSourceConfig;
  detector: WatchDetectorConfig;
}

export interface WatchRecord extends WatchSpec {
  id: string;
  sessionId: string;
  createdByIdentityId?: string;
  enabled: boolean;
  nextPollAt?: number;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
  cooldownUntil?: number;
  lastError?: string;
  state?: JsonObject;
  disabledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface WatchRunRecord {
  id: string;
  watchId: string;
  sessionId: string;
  createdByIdentityId?: string;
  scheduledFor: number;
  status: WatchRunStatus;
  resolvedThreadId?: string;
  emittedEventId?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface WatchEventRecord {
  id: string;
  watchId: string;
  sessionId: string;
  createdByIdentityId?: string;
  resolvedThreadId?: string;
  eventKind: WatchEventKind;
  summary: string;
  dedupeKey: string;
  payload?: JsonObject;
  createdAt: number;
}

export interface CreateWatchInput extends WatchSpec {
  sessionId: string;
  createdByIdentityId?: string;
  enabled?: boolean;
  state?: JsonObject;
  nextPollAt?: number | null;
}

export interface UpdateWatchInput {
  watchId: string;
  sessionId: string;
  title?: string;
  intervalMinutes?: number;
  source?: WatchSourceConfig;
  detector?: WatchDetectorConfig;
  enabled?: boolean;
  state?: JsonObject | null;
  nextPollAt?: number | null;
}

export interface DisableWatchInput {
  watchId: string;
  sessionId: string;
  reason?: string;
}

export interface ListDueWatchesInput {
  asOf?: number;
  limit?: number;
}

export interface ClaimWatchInput {
  watchId: string;
  claimedBy: string;
  claimExpiresAt: number;
  nextPollAt?: number;
}

export interface ClaimWatchResult {
  watch: WatchRecord;
  run: WatchRunRecord;
}

export interface StartWatchRunInput {
  runId: string;
  resolvedThreadId?: string;
}

export interface CompleteWatchRunInput {
  runId: string;
  status: Extract<WatchRunStatus, "no_change" | "changed">;
  state?: JsonObject;
  resolvedThreadId?: string;
  emittedEventId?: string;
  lastError?: string | null;
}

export interface FailWatchRunInput {
  runId: string;
  error: string;
  state?: JsonObject;
  resolvedThreadId?: string;
}

export interface RecordWatchEventInput {
  watchId: string;
  sessionId: string;
  createdByIdentityId?: string;
  resolvedThreadId: string;
  eventKind: WatchEventKind;
  summary: string;
  dedupeKey: string;
  payload?: JsonObject;
}

export interface WatchThreadInputMetadataValue extends JsonObject {
  watchId: string;
  title: string;
  eventId: string;
  eventKind: WatchEventKind;
  occurredAt: string;
}

export interface WatchThreadInputMetadata extends JsonObject {
  watchEvent: WatchThreadInputMetadataValue;
}

export interface WatchCollectionItem {
  id: string;
  cursor: WatchCursorValue;
  summary?: string;
  data?: JsonObject;
}

export interface WatchCollectionObservation {
  kind: "collection";
  items: readonly WatchCollectionItem[];
}

export interface WatchSnapshotObservation extends JsonObject {
  kind: "snapshot";
  text: string;
}

export interface WatchScalarObservation {
  kind: "scalar";
  value: number;
  label?: string;
}

export type WatchObservation =
  | WatchCollectionObservation
  | WatchSnapshotObservation
  | WatchScalarObservation;

export interface WatchSourceEvaluation {
  observation: WatchObservation;
  identityToken?: string;
}

export interface WatchEventDraft {
  eventKind: WatchEventKind;
  summary: string;
  dedupeKey: string;
  payload?: JsonObject;
}

export interface WatchEvaluationResult {
  changed: boolean;
  nextState: JsonObject;
  event?: WatchEventDraft;
}

export function parseWatchThreadInputMetadata(value: unknown): WatchThreadInputMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value.watchEvent;
  if (!isRecord(candidate)) {
    return null;
  }

  if (
    typeof candidate.watchId !== "string"
    || typeof candidate.title !== "string"
    || typeof candidate.eventId !== "string"
    || (candidate.eventKind !== "new_items"
      && candidate.eventKind !== "snapshot_changed"
      && candidate.eventKind !== "percent_change")
    || typeof candidate.occurredAt !== "string"
  ) {
    return null;
  }

  return {
    watchEvent: {
      watchId: candidate.watchId,
      title: candidate.title,
      eventId: candidate.eventId,
      eventKind: candidate.eventKind,
      occurredAt: candidate.occurredAt,
    },
  };
}
