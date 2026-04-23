export type AgentAppActionMode = "native" | "wake" | "native+wake";

export interface AgentAppManifest {
  name: string;
  description?: string;
  identityScoped?: boolean;
  publicDir?: string;
  entryHtml?: string;
  viewsPath?: string;
  actionsPath?: string;
  dbPath?: string;
}

export interface AgentAppViewPagination {
  mode: "offset";
  defaultPageSize?: number;
  maxPageSize?: number;
}

export interface AgentAppViewDefinition {
  description?: string;
  sql: string;
  pagination?: AgentAppViewPagination;
}

interface AgentAppInputFieldBase {
  description?: string;
}

export interface AgentAppStringInputField extends AgentAppInputFieldBase {
  type: "string";
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
}

export interface AgentAppIntegerInputField extends AgentAppInputFieldBase {
  type: "integer";
  enum?: readonly number[];
  minimum?: number;
  maximum?: number;
}

export interface AgentAppNumberInputField extends AgentAppInputFieldBase {
  type: "number";
  enum?: readonly number[];
  minimum?: number;
  maximum?: number;
}

export interface AgentAppBooleanInputField extends AgentAppInputFieldBase {
  type: "boolean";
}

export type AgentAppScalarInputField =
  | AgentAppStringInputField
  | AgentAppIntegerInputField
  | AgentAppNumberInputField
  | AgentAppBooleanInputField;

export interface AgentAppArrayInputField extends AgentAppInputFieldBase {
  type: "array";
  items: AgentAppScalarInputField;
  minItems?: number;
  maxItems?: number;
}

export type AgentAppInputField = AgentAppScalarInputField | AgentAppArrayInputField;

export interface AgentAppActionInputSchema {
  type: "object";
  description?: string;
  properties?: Readonly<Record<string, AgentAppInputField>>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface AgentAppActionDefinition {
  description?: string;
  mode?: AgentAppActionMode;
  sql: string | readonly string[];
  requiredInputKeys?: readonly string[];
  inputSchema?: AgentAppActionInputSchema;
  wakeMessage?: string;
}

export interface AgentAppDefinition {
  agentKey: string;
  slug: string;
  name: string;
  description?: string;
  identityScoped: boolean;
  appDir: string;
  manifestPath: string;
  viewsPath: string;
  actionsPath: string;
  publicDir: string;
  entryHtmlPath: string;
  hasUi: boolean;
  dbPath: string;
  views: Readonly<Record<string, AgentAppViewDefinition>>;
  actions: Readonly<Record<string, AgentAppActionDefinition>>;
}

export interface AgentAppDiagnosticIssue {
  file: string;
  path?: string;
  message: string;
}

export interface AgentAppCheckResult {
  appSlug: string;
  appDir: string;
  ok: boolean;
  errors: readonly AgentAppDiagnosticIssue[];
  warnings: readonly AgentAppDiagnosticIssue[];
}

export interface AgentAppInspectionResult {
  apps: readonly AgentAppDefinition[];
  brokenApps: readonly AgentAppCheckResult[];
}

export interface AgentAppViewPage {
  mode: "offset";
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface AgentAppViewResult {
  items: Record<string, unknown>[];
  page?: AgentAppViewPage;
}

export interface AgentAppActionResult {
  mode: AgentAppActionMode;
  changes: number;
  lastInsertRowid?: number | string;
  rows?: Record<string, unknown>[];
  wakeRequested: boolean;
}

const APP_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const APP_PARAM_PATTERN = /^[a-z][a-z0-9_]*$/;

function normalizeAppSegment(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }

  if (!APP_SEGMENT_PATTERN.test(normalized)) {
    throw new Error(`${label} must use lowercase letters, numbers, hyphens, or underscores.`);
  }

  return normalized;
}

export function normalizeAgentAppSlug(value: string): string {
  return normalizeAppSegment(value, "App slug");
}

export function normalizeAgentAppEntryKey(value: string, label = "App entry key"): string {
  return normalizeAppSegment(value, label);
}

export function normalizeAgentAppParamKey(value: string, label = "App parameter key"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }

  if (!APP_PARAM_PATTERN.test(trimmed)) {
    throw new Error(`${label} must use lowercase letters, numbers, or underscores and must start with a letter.`);
  }

  return trimmed;
}

/**
 * Prefer the richer schema-required keys when present, while keeping the
 * lighter requiredInputKeys fallback for simple apps and older definitions.
 */
export function readAgentAppRequiredInputKeys(
  definition: Pick<AgentAppActionDefinition, "requiredInputKeys" | "inputSchema">,
): readonly string[] | undefined {
  return definition.inputSchema?.required?.length
    ? definition.inputSchema.required
    : definition.requiredInputKeys;
}
