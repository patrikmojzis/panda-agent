import {createHash, randomUUID} from "node:crypto";

import type {ThinkingLevel} from "@mariozechner/pi-ai";

import type {JsonObject} from "../../lib/json.js";
import {generateOpaqueToken, hashOpaqueToken} from "../../lib/opaque-tokens.js";
import {requireNonEmptyString, trimToUndefined} from "../../lib/strings.js";
import type {
    A2ASessionBindingLookup,
    A2ASessionBindingRecord,
    BindA2ASessionInput,
    ListA2ASessionBindingsInput
} from "../a2a/types.js";
import type {AgentStore} from "../agents/store.js";
import {normalizeAgentSkillTag, normalizeAgentSkillTags, type AgentPairingRecord, type AgentSkillRecord} from "../agents/types.js";
import type {CredentialService} from "../credentials/resolver.js";
import {PostgresConnectorAccountStore} from "../connectors/postgres.js";
import type {ConnectorAccountRecord} from "../connectors/types.js";
import type {CredentialCrypto} from "../credentials/crypto.js";
import type {
    EmailAccountRecord,
    EmailAllowedRecipientRecord,
    EmailEndpointConfig,
    EmailRouteRecord,
    EmailStore
} from "../email/types.js";
import {buildCredentialTableNames} from "../credentials/postgres-shared.js";
import {buildConnectorAccountTableNames} from "../connectors/postgres-shared.js";
import {PostgresGatewayStore} from "../gateway/postgres.js";
import {normalizeGatewayEventType} from "../gateway/postgres-rows.js";
import type {
    GatewayDeviceCapability,
    GatewayDeviceRecord,
    GatewayEventRecord,
    GatewayEventTypeRecord,
    GatewaySourceRecord,
} from "../gateway/types.js";
import {buildGatewayTableNames} from "../gateway/postgres-shared.js";
import {buildOutboundDeliveryTableNames} from "../channels/deliveries/postgres-shared.js";
import type {IdentityStore} from "../identity/store.js";
import {
    type IdentityBindingRecord,
    type IdentityRecord,
    type IdentityStatus,
    normalizeIdentityHandle
} from "../identity/types.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildScheduledTaskTableNames} from "../scheduling/tasks/postgres-shared.js";
import {ConversationRepo} from "../sessions/conversations/repo.js";
import {buildConversationSessionTableNames} from "../sessions/conversations/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {SessionStore} from "../sessions/store.js";
import type {AgentSessionKind, SessionRecord} from "../sessions/types.js";
import {normalizeSessionAlias} from "../sessions/types.js";
import type {SubagentProfileStore} from "../subagents/store.js";
import type {SubagentProfileRecord} from "../subagents/types.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {ThreadRuntimeStore} from "../threads/runtime/store.js";
import type {WikiBindingService} from "../wiki/service.js";
import type {WikiBindingRecord} from "../wiki/types.js";
import {normalizeWikiGroupId, normalizeWikiNamespacePath} from "../wiki/types.js";
import type {ControlAuditEventSummary, ControlReadService} from "./read-service.js";
import type {ControlSessionRecord} from "./types.js";

const GATEWAY_DEVICE_TOKEN_PREFIX = "pgd";
const GATEWAY_DEVICE_TOKEN_BYTES = 24;

export type ControlSortDirection = "asc" | "desc";

export interface ControlTableInput {
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortDirection?: ControlSortDirection;
  search?: string;
}

export interface ControlSessionTableInput extends ControlTableInput {
  kind?: Extract<AgentSessionKind, "main" | "branch">;
  visibility?: "primary" | "subagent" | "all";
}

export interface ControlConnectorTableInput extends ControlTableInput {
  source?: string;
  status?: string;
}

export interface ControlSkillTableInput extends ControlTableInput {
  tag?: string;
}

export interface ControlSubagentTableInput extends ControlTableInput {
  enabled?: boolean;
  source?: string;
  toolGroups?: readonly string[];
}

export interface ControlGatewayDeviceTableInput extends ControlTableInput {
  enabled?: boolean;
  capabilities?: readonly string[];
}

export interface ControlBindingTableInput extends ControlTableInput {
  source?: string;
  sessionId?: string;
}

export interface ControlEmailRouteTableInput extends ControlTableInput {
  accountKey?: string;
}

export interface ControlEmailAllowedRecipientTableInput extends ControlTableInput {
  accountKey?: string;
}

export interface ControlDiscordActorPairingTableInput extends ControlTableInput {
  accountKey?: string;
}

export type ControlChannelActorPairingSource = "telegram" | "whatsapp";

export interface ControlChannelActorPairingTableInput extends ControlTableInput {
  source?: ControlChannelActorPairingSource;
  connectorKey?: string;
}

export interface ControlAgentPairingTableInput extends ControlTableInput {
  status?: IdentityStatus;
}

export interface ControlIdentityTableInput extends ControlTableInput {
  status?: IdentityStatus;
}

export interface ControlA2ABindingTableInput extends ControlTableInput {
  direction?: "outbound" | "inbound";
}

export interface ControlTableMeta {
  current_page: number;
  last_page: number;
  total: number;
  per_page: number;
}

export interface ControlPaginatedResponse<T> {
  data: T[];
  meta: ControlTableMeta;
}

export interface ControlAgentRow {
  agentKey: string;
  displayName: string;
  status: string;
  sessionCount: number;
  paired: boolean;
}

export interface ControlAgentDetail extends ControlAgentRow {
  credentialCount: number;
  connectorCount: number;
  pairingCount: number;
  skillCount: number;
  subagentCount: number;
  gatewaySourceCount: number;
  wikiBindingSet: boolean;
}

export interface ControlSessionRow {
  id: string;
  agentKey: string;
  kind: string;
  isSubagent: boolean;
  currentThreadId: string;
  alias?: string;
  displayName?: string;
  label: string;
  createdByIdentityId?: string;
  heartbeatEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ControlSessionDetail extends ControlSessionRow {
  briefingSet: boolean;
  runtime: {
    model?: string;
    thinking?: string;
    thinkingConfigured: boolean;
    pendingWakeAt?: string;
  };
}

export interface ControlCredentialRow {
  agentKey: string;
  envKey: string;
  present: true;
  createdAt: string;
  updatedAt: string;
}

export interface ControlConnectorRow {
  id: string;
  source: string;
  accountKey: string;
  connectorKey: string;
  displayName?: string;
  externalAccountId?: string;
  externalUsername?: string;
  status: string;
  ownerKind: string;
  ownerAgentKey?: string;
  secretKeys: string[];
  email?: ControlEmailConnectorConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ControlEmailConnectorEndpointConfig {
  host: string;
  port?: number;
  secure?: boolean;
  usernameCredentialEnvKey: string;
  passwordCredentialEnvKey: string;
}

export interface ControlEmailConnectorConfig {
  fromAddress: string;
  fromName?: string;
  mailboxes: readonly string[];
  credentialKeys: readonly string[];
  imap: ControlEmailConnectorEndpointConfig;
  smtp: ControlEmailConnectorEndpointConfig;
}

export interface ControlBindingRow {
  source: string;
  connectorKey: string;
  externalConversationId: string;
  sessionId: string;
  sessionLabel: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlA2ABindingRow {
  senderSessionId: string;
  senderAgentKey: string;
  senderSessionLabel: string;
  recipientSessionId: string;
  recipientAgentKey: string;
  recipientSessionLabel: string;
  direction: "outbound" | "inbound";
  createdAt: string;
  updatedAt: string;
}

export interface ControlEmailRouteRow {
  id: string;
  agentKey: string;
  accountKey: string;
  mailbox?: string;
  sessionId: string;
  sessionLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlEmailAllowedRecipientRow {
  agentKey: string;
  accountKey: string;
  address: string;
  createdAt: string;
}

export interface ControlIdentityOptionRow {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  agentPairingCount: number;
  actorBindingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlAgentPairingRow {
  agentKey: string;
  identityId: string;
  identityHandle: string;
  identityDisplayName: string;
  identityStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlDiscordActorPairingRow {
  agentKey: string;
  accountKey: string;
  connectorKey: string;
  externalActorId: string;
  identityId: string;
  identityHandle: string;
  identityDisplayName: string;
  identityStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlChannelActorPairingRow {
  agentKey: string;
  source: ControlChannelActorPairingSource;
  connectorKey: string;
  externalActorId: string;
  identityId: string;
  identityHandle: string;
  identityDisplayName: string;
  identityStatus: string;
  createdAt: string;
  updatedAt: string;
}

export type ControlTelegramSetupChecklistStatus = "done" | "warning" | "blocked" | "info";

export interface ControlTelegramSetupChecklistItem {
  key: string;
  label: string;
  status: ControlTelegramSetupChecklistStatus;
  detail: string;
  action?: string;
}

export interface ControlTelegramSetupStatus {
  agentKey: string;
  accountKey: string;
  account: {
    exists: boolean;
    enabled: boolean;
    status?: string;
    ownerAgentKey?: string;
    connectorKey?: string;
    displayName?: string;
    externalUsername?: string;
    tokenStored: boolean;
    tokenValid: "not_checked" | "valid" | "invalid" | "missing_secret" | "unavailable";
    validationError?: string;
  };
  sessionBindings: {
    total: number;
    bindings: ControlBindingRow[];
  };
  actorPairings: {
    total: number;
    pairings: ControlChannelActorPairingRow[];
  };
  agentPairings: {
    total: number;
    identities: ControlAgentPairingRow[];
  };
  worker: {
    enabled: boolean;
    reloadRequired: boolean;
    detail: string;
    smokeCommand: string;
  };
  trace: {
    collectorEnabled: boolean;
    serviceSelected: boolean;
    sourceEnvKey: string;
    sourceConfigured: boolean;
    detail: string;
  };
  checklist: ControlTelegramSetupChecklistItem[];
}

export interface ControlSkillRow {
  agentKey: string;
  skillKey: string;
  description: string;
  content?: string;
  tags: readonly string[];
  lastLoadedAt?: string;
  loadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlSubagentRow {
  slug: string;
  agentKey?: string;
  description: string;
  prompt?: string;
  toolGroups: readonly string[];
  model?: string;
  thinking?: string;
  transcriptMode: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ControlGatewaySourceRow {
  sourceId: string;
  name: string;
  clientId: string;
  agentKey: string;
  identityId: string;
  sessionId?: string;
  status: string;
  suspendedAt?: string;
  suspendReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlGatewaySourceSecretResult {
  source: ControlGatewaySourceRow;
  clientSecret: string;
}

export interface ControlGatewayDeviceRow {
  sourceId: string;
  deviceId: string;
  label?: string;
  capabilities: readonly GatewayDeviceCapability[];
  enabled: boolean;
  disabledAt?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlGatewayEventTypeRow {
  sourceId: string;
  type: string;
  delivery: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlGatewayEventRow {
  id: string;
  sourceId: string;
  type: string;
  deliveryRequested: string;
  deliveryEffective: string;
  occurredAt?: string;
  status: string;
  riskScore?: number;
  reason?: string;
  threadId?: string;
  textBytes: number;
  textSha256: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface ControlWikiBindingRow {
  agentKey: string;
  wikiGroupId: number;
  namespacePath: string;
  createdAt: string;
  updatedAt: string;
}

export type ControlWorkFailureKind =
  | "runtime_run"
  | "scheduled_task_run"
  | "outbound_delivery"
  | "gateway_event"
  | "gateway_device_command"
  | "connector_account";

export interface ControlWorkFailureTableInput extends ControlTableInput {
  severity?: "warning" | "critical";
  kind?: ControlWorkFailureKind;
}

export interface ControlWorkFailureRow {
  id: string;
  kind: ControlWorkFailureKind;
  severity: "warning" | "critical";
  agentKey: string;
  sessionId?: string;
  sessionLabel?: string;
  source: string;
  summary: string;
  detail?: string;
  targetRoute: string;
  createdAt: string;
}

export interface ControlGlobalSearchResult {
  id: string;
  kind: "agent" | "session" | "identity" | "work_failure" | "credential" | "connector" | "binding" | "skill" | "subagent" | "gateway_source" | "gateway_device";
  title: string;
  subtitle: string;
  targetRoute: string;
  agentKey?: string;
  sessionId?: string;
  updatedAt?: string;
}

export interface ControlOperatorServiceOptions {
  pool: PgQueryable;
  reads: Pick<ControlReadService, "listAgents" | "listAuditEvents">;
  a2aBindings: ControlA2ABindingStore;
  agents: AgentStore;
  sessions: SessionStore;
  threads: Pick<ThreadRuntimeStore, "createThread">;
  identities: Pick<
    IdentityStore,
    | "getIdentity"
    | "getIdentityByHandle"
    | "listIdentities"
    | "listIdentityBindings"
    | "resolveIdentityBinding"
    | "createIdentity"
    | "updateIdentity"
    | "ensureIdentityBinding"
    | "deleteIdentityBinding"
  >;
  credentials: CredentialService | null;
  email: ControlEmailStore;
  connectorAccounts: PostgresConnectorAccountStore;
  connectorCrypto: CredentialCrypto | null;
  conversations: ConversationRepo;
  gateway: PostgresGatewayStore;
  subagents: SubagentProfileStore;
  wikiBindings: ControlWikiBindings;
  telegramBotIdentityClient?: ControlTelegramBotIdentityClient;
}

const CONTROL_TELEGRAM_SOURCE = "telegram";
const CONTROL_TELEGRAM_BOT_TOKEN_SECRET_KEY = "bot_token";

function controlSecretRedactionFragments(secret: string): readonly string[] {
  const exact = secret.trim();
  if (!exact) return [];
  const pieces = exact
    .split(/[^A-Za-z0-9]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 8);
  return [...new Set([exact, ...pieces])];
}

function controlSanitizeSecretErrorMessage(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message || "Telegram validation failed.";
  for (const fragment of controlSecretRedactionFragments(secret)) {
    sanitized = sanitized.split(fragment).join("[redacted]");
  }
  return sanitized || "Telegram validation failed.";
}

async function controlTelegramGetBotIdentitySafely(client: ControlTelegramBotIdentityClient, token: string): Promise<ControlTelegramBotIdentity> {
  try {
    return await client.getBotIdentity(token);
  } catch (error) {
    throw new Error(controlSanitizeSecretErrorMessage(error, token));
  }
}

export type ControlTelegramBotIdentity = {
  id: string;
  username?: string;
  displayName?: string;
};

export type ControlTelegramBotIdentityClient = {
  getBotIdentity(token: string): Promise<ControlTelegramBotIdentity>;
};

type ControlA2ABindingStore = {
  bindSession(input: BindA2ASessionInput): Promise<A2ASessionBindingRecord>;
  deleteBinding(lookup: A2ASessionBindingLookup): Promise<boolean>;
  listBindings(input?: ListA2ASessionBindingsInput): Promise<readonly A2ASessionBindingRecord[]>;
};

type ControlEmailStore = Pick<
  EmailStore,
  | "upsertAccount"
  | "disableAccount"
  | "getAccount"
  | "setRoute"
  | "removeRoute"
  | "listRoutes"
  | "addAllowedRecipient"
  | "removeAllowedRecipient"
  | "listAllowedRecipients"
>;

type ControlWikiBindingStore = {
  deleteBinding(agentKey: string): Promise<boolean>;
  getBinding(agentKey: string): Promise<WikiBindingRecord | null>;
};

type ControlWikiBindings = {
  store: ControlWikiBindingStore;
  service: Pick<WikiBindingService, "setBinding"> | null;
};

function pageNumber(value: number | undefined): number {
  return Math.max(1, Math.trunc(value ?? 1));
}

function perPageNumber(value: number | undefined): number {
  return Math.max(1, Math.min(100, Math.trunc(value ?? 25)));
}

function normalizeSearch(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function tableResponse<T>(items: readonly T[], input: ControlTableInput = {}): ControlPaginatedResponse<T> {
  const page = pageNumber(input.page);
  const perPage = perPageNumber(input.perPage);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return {
    data: items.slice(start, start + perPage),
    meta: {
      current_page: page,
      last_page: lastPage,
      total,
      per_page: perPage,
    },
  };
}

function sortText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : String(value ?? "").toLowerCase();
}

function sortRows<T>(rows: readonly T[], input: ControlTableInput, fallback: keyof T & string): T[] {
  const sortBy = (input.sortBy && input.sortBy in (rows[0] ?? {})) ? input.sortBy : String(fallback);
  const direction = input.sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftValue = (left as Record<string, unknown>)[sortBy];
    const rightValue = (right as Record<string, unknown>)[sortBy];
    return direction * sortText(leftValue).localeCompare(sortText(rightValue));
  });
}

function iso(value: number | Date | string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  const millis = date.getTime();
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function sessionLabel(session: Pick<SessionRecord, "id" | "alias" | "displayName">): string {
  return session.displayName?.trim() || session.alias?.trim() || session.id;
}

function publicSessionRow(session: SessionRecord, heartbeatEnabled = session.kind === "main"): ControlSessionRow {
  return {
    id: session.id,
    agentKey: session.agentKey,
    kind: session.kind,
    isSubagent: isSubagentSessionKind(session.kind),
    currentThreadId: session.currentThreadId,
    ...(session.alias ? {alias: session.alias} : {}),
    ...(session.displayName ? {displayName: session.displayName} : {}),
    label: sessionLabel(session),
    ...(session.createdByIdentityId ? {createdByIdentityId: session.createdByIdentityId} : {}),
    heartbeatEnabled,
    createdAt: iso(session.createdAt)!,
    updatedAt: iso(session.updatedAt)!,
  };
}

function isSubagentSessionKind(kind: AgentSessionKind | string): boolean {
  return kind === "subagent" || kind === "worker";
}

function publicEmailEndpointConfig(value: unknown): ControlEmailConnectorEndpointConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.host !== "string" || typeof record.usernameCredentialEnvKey !== "string" || typeof record.passwordCredentialEnvKey !== "string") {
    return undefined;
  }
  return {
    host: record.host,
    ...(typeof record.port === "number" ? {port: record.port} : {}),
    ...(typeof record.secure === "boolean" ? {secure: record.secure} : {}),
    usernameCredentialEnvKey: record.usernameCredentialEnvKey,
    passwordCredentialEnvKey: record.passwordCredentialEnvKey,
  };
}

function publicEmailConnectorConfig(config: Record<string, unknown>): ControlEmailConnectorConfig | undefined {
  const imap = publicEmailEndpointConfig(config.imap);
  const smtp = publicEmailEndpointConfig(config.smtp);
  if (!imap || !smtp || typeof config.fromAddress !== "string") return undefined;
  const mailboxes = Array.isArray(config.mailboxes)
    ? config.mailboxes.filter((mailbox): mailbox is string => typeof mailbox === "string")
    : ["INBOX"];
  return {
    fromAddress: config.fromAddress,
    ...(typeof config.fromName === "string" ? {fromName: config.fromName} : {}),
    mailboxes: mailboxes.length > 0 ? mailboxes : ["INBOX"],
    credentialKeys: [
      imap.usernameCredentialEnvKey,
      imap.passwordCredentialEnvKey,
      smtp.usernameCredentialEnvKey,
      smtp.passwordCredentialEnvKey,
    ],
    imap,
    smtp,
  };
}

function publicConnector(account: ConnectorAccountRecord, secretKeys: readonly string[] = []): ControlConnectorRow {
  const emailConfig = account.source === "email" ? publicEmailConnectorConfig(account.config) : undefined;
  return {
    id: account.id,
    source: account.source,
    accountKey: account.accountKey,
    connectorKey: account.connectorKey,
    ...(account.displayName ? {displayName: account.displayName} : {}),
    ...(account.externalAccountId ? {externalAccountId: account.externalAccountId} : {}),
    ...(account.externalUsername ? {externalUsername: account.externalUsername} : {}),
    status: account.status,
    ownerKind: account.ownerKind,
    ...(account.ownerAgentKey ? {ownerAgentKey: account.ownerAgentKey} : {}),
    secretKeys: [...secretKeys],
    ...(emailConfig ? {email: emailConfig} : {}),
    createdAt: iso(account.createdAt)!,
    updatedAt: iso(account.updatedAt)!,
  };
}

function publicEmailRoute(route: EmailRouteRecord, session?: SessionRecord): ControlEmailRouteRow {
  return {
    id: route.id,
    agentKey: route.agentKey,
    accountKey: route.accountKey,
    ...(route.mailbox ? {mailbox: route.mailbox} : {}),
    sessionId: route.sessionId,
    sessionLabel: session ? sessionLabel(session) : route.sessionId,
    createdAt: iso(route.createdAt)!,
    updatedAt: iso(route.updatedAt)!,
  };
}

function publicEmailAllowedRecipient(recipient: EmailAllowedRecipientRecord): ControlEmailAllowedRecipientRow {
  return {
    agentKey: recipient.agentKey,
    accountKey: recipient.accountKey,
    address: recipient.address,
    createdAt: iso(recipient.createdAt)!,
  };
}

function publicIdentityOption(
  identity: IdentityRecord,
  counts: {agentPairingCount?: number; actorBindingCount?: number} = {},
): ControlIdentityOptionRow {
  return {
    id: identity.id,
    handle: identity.handle,
    displayName: identity.displayName,
    status: identity.status,
    agentPairingCount: counts.agentPairingCount ?? 0,
    actorBindingCount: counts.actorBindingCount ?? 0,
    createdAt: iso(identity.createdAt)!,
    updatedAt: iso(identity.updatedAt)!,
  };
}

function publicAgentPairing(
  pairing: AgentPairingRecord,
  identity: IdentityRecord,
): ControlAgentPairingRow {
  return {
    agentKey: pairing.agentKey,
    identityId: pairing.identityId,
    identityHandle: identity.handle,
    identityDisplayName: identity.displayName,
    identityStatus: identity.status,
    createdAt: iso(pairing.createdAt)!,
    updatedAt: iso(pairing.updatedAt)!,
  };
}

function publicDiscordActorPairing(
  binding: IdentityBindingRecord,
  identity: IdentityRecord,
  account: ConnectorAccountRecord,
): ControlDiscordActorPairingRow {
  return {
    agentKey: account.ownerAgentKey ?? "",
    accountKey: account.accountKey,
    connectorKey: account.connectorKey,
    externalActorId: binding.externalActorId,
    identityId: identity.id,
    identityHandle: identity.handle,
    identityDisplayName: identity.displayName,
    identityStatus: identity.status,
    createdAt: iso(binding.createdAt)!,
    updatedAt: iso(binding.updatedAt)!,
  };
}

function publicChannelActorPairing(
  binding: IdentityBindingRecord,
  identity: IdentityRecord,
  agentKey: string,
): ControlChannelActorPairingRow {
  return {
    agentKey,
    source: binding.source as ControlChannelActorPairingSource,
    connectorKey: binding.connectorKey,
    externalActorId: binding.externalActorId,
    identityId: identity.id,
    identityHandle: identity.handle,
    identityDisplayName: identity.displayName,
    identityStatus: identity.status,
    createdAt: iso(binding.createdAt)!,
    updatedAt: iso(binding.updatedAt)!,
  };
}

function publicSkill(skill: AgentSkillRecord, includeContent = false): ControlSkillRow {
  return {
    agentKey: skill.agentKey,
    skillKey: skill.skillKey,
    description: skill.description,
    ...(includeContent ? {content: skill.content} : {}),
    tags: skill.tags,
    ...(skill.lastLoadedAt ? {lastLoadedAt: iso(skill.lastLoadedAt)} : {}),
    loadCount: skill.loadCount,
    createdAt: iso(skill.createdAt)!,
    updatedAt: iso(skill.updatedAt)!,
  };
}

function parseControlSkillTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Skill tags must be an array of strings.");
  return normalizeAgentSkillTags(value);
}

function publicSubagent(profile: SubagentProfileRecord, includePrompt = false): ControlSubagentRow {
  return {
    slug: profile.slug,
    ...(profile.agentKey ? {agentKey: profile.agentKey} : {}),
    description: profile.description,
    ...(includePrompt ? {prompt: profile.prompt} : {}),
    toolGroups: profile.toolGroups,
    ...(profile.model ? {model: profile.model} : {}),
    ...(profile.thinking ? {thinking: profile.thinking} : {}),
    transcriptMode: profile.transcriptMode,
    source: profile.source,
    enabled: profile.enabled,
    createdAt: iso(profile.createdAt)!,
    updatedAt: iso(profile.updatedAt)!,
  };
}

function publicGatewaySource(source: GatewaySourceRecord): ControlGatewaySourceRow {
  return {
    sourceId: source.sourceId,
    name: source.name,
    clientId: source.clientId,
    agentKey: source.agentKey,
    identityId: source.identityId,
    ...(source.sessionId ? {sessionId: source.sessionId} : {}),
    status: source.status,
    ...(source.suspendedAt ? {suspendedAt: iso(source.suspendedAt)} : {}),
    ...(source.suspendReason ? {suspendReason: source.suspendReason} : {}),
    createdAt: iso(source.createdAt)!,
    updatedAt: iso(source.updatedAt)!,
  };
}

function publicGatewayDevice(device: GatewayDeviceRecord): ControlGatewayDeviceRow {
  return {
    sourceId: device.sourceId,
    deviceId: device.deviceId,
    ...(device.label ? {label: device.label} : {}),
    capabilities: device.capabilities,
    enabled: device.enabled,
    ...(device.disabledAt ? {disabledAt: iso(device.disabledAt)} : {}),
    ...(device.lastSeenAt ? {lastSeenAt: iso(device.lastSeenAt)} : {}),
    createdAt: iso(device.createdAt)!,
    updatedAt: iso(device.updatedAt)!,
  };
}

function publicGatewayEventType(eventType: GatewayEventTypeRecord): ControlGatewayEventTypeRow {
  return {
    sourceId: eventType.sourceId,
    type: eventType.type,
    delivery: eventType.delivery,
    createdAt: iso(eventType.createdAt)!,
    updatedAt: iso(eventType.updatedAt)!,
  };
}

function publicGatewayEvent(event: GatewayEventRecord): ControlGatewayEventRow {
  return {
    id: event.id,
    sourceId: event.sourceId,
    type: event.type,
    deliveryRequested: event.deliveryRequested,
    deliveryEffective: event.deliveryEffective,
    ...(event.occurredAt ? {occurredAt: iso(event.occurredAt)} : {}),
    status: event.status,
    ...(event.riskScore !== undefined ? {riskScore: event.riskScore} : {}),
    ...(event.reason ? {reason: event.reason} : {}),
    ...(event.threadId ? {threadId: event.threadId} : {}),
    textBytes: event.textBytes,
    textSha256: event.textSha256,
    createdAt: iso(event.createdAt)!,
    ...(event.deliveredAt ? {deliveredAt: iso(event.deliveredAt)} : {}),
  };
}

function publicWikiBinding(binding: WikiBindingRecord): ControlWikiBindingRow {
  return {
    agentKey: binding.agentKey,
    wikiGroupId: binding.wikiGroupId,
    namespacePath: binding.namespacePath,
    createdAt: iso(binding.createdAt)!,
    updatedAt: iso(binding.updatedAt)!,
  };
}

function secretSummary(value: string): {length: number; sha256: string} {
  return {
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function parseOptionalPort(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${label} port must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function parseOptionalSecure(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "" || value === "default") return undefined;
  if (value === true || value === "true" || value === "secure") return true;
  if (value === false || value === "false" || value === "starttls") return false;
  throw new Error("Email secure mode must be default, secure, or starttls.");
}

function parseMailboxList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  const mailboxes = [...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))];
  return mailboxes.length > 0 ? mailboxes : ["INBOX"];
}

function emailCredentialEnvKey(accountKey: string, endpoint: "imap" | "smtp", part: "username" | "password"): string {
  const accountSlug = accountKey
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "ACCOUNT";
  return `EMAIL_${accountSlug}_${endpoint.toUpperCase()}_${part.toUpperCase()}`;
}

function buildEmailEndpoint(input: {
  host: unknown;
  port: unknown;
  secure: unknown;
  usernameCredentialEnvKey: string;
  passwordCredentialEnvKey: string;
  label: "IMAP" | "SMTP";
}): EmailEndpointConfig {
  const port = parseOptionalPort(input.port, input.label);
  const secure = parseOptionalSecure(input.secure);
  return {
    host: requireNonEmptyString(input.host, `${input.label} host is required.`),
    ...(port !== undefined ? {port} : {}),
    ...(secure !== undefined ? {secure} : {}),
    usernameCredentialEnvKey: input.usernameCredentialEnvKey,
    passwordCredentialEnvKey: input.passwordCredentialEnvKey,
  };
}

function emailEndpointConfigJson(endpoint: EmailEndpointConfig): JsonObject {
  return {
    host: endpoint.host,
    ...(endpoint.port !== undefined ? {port: endpoint.port} : {}),
    ...(endpoint.secure !== undefined ? {secure: endpoint.secure} : {}),
    usernameCredentialEnvKey: endpoint.usernameCredentialEnvKey,
    passwordCredentialEnvKey: endpoint.passwordCredentialEnvKey,
  };
}

function existingEmailAccount(email: Pick<EmailStore, "getAccount">, agentKey: string, accountKey: string): Promise<EmailAccountRecord | null> {
  return email.getAccount(agentKey, accountKey).catch(() => null);
}

type ControlCreateSessionKind = Extract<AgentSessionKind, "main" | "branch">;

function controlCreateSessionKind(value: unknown): ControlCreateSessionKind {
  if (value === undefined || value === null || value === "") return "branch";
  if (value === "main" || value === "branch") return value;
  throw new Error("Control sessions can only be created as main or branch sessions.");
}

function controlDiscordActorId(value: unknown): string {
  const actorId = requireNonEmptyString(value, "Discord actor id is required.");
  if (!/^\d{1,20}$/.test(actorId) || !/[1-9]/.test(actorId)) {
    throw new Error("Discord actor must be a numeric Discord user id/snowflake, not a username or display name.");
  }
  return actorId;
}

function isControlChannelActorPairingSource(value: string): value is ControlChannelActorPairingSource {
  return value === "telegram" || value === "whatsapp";
}

function controlChannelActorPairingSource(value: unknown): ControlChannelActorPairingSource {
  const source = requireNonEmptyString(value, "Channel actor pairing source is required.").toLowerCase();
  if (isControlChannelActorPairingSource(source)) return source;
  throw new Error("Channel actor pairing source must be telegram or whatsapp.");
}

function controlChannelConnectorKey(source: ControlChannelActorPairingSource, value: unknown): string {
  if ((value === undefined || value === null || value === "") && source === "whatsapp") return "main";
  return requireNonEmptyString(value, `${source} connector key is required.`);
}

function controlTelegramActorId(value: unknown): string {
  const actorId = requireNonEmptyString(value, "Telegram actor id is required.");
  if (!/^\d+$/.test(actorId) || !/[1-9]/.test(actorId)) {
    throw new Error("Telegram actor id must be a positive integer string.");
  }
  return actorId;
}

function controlWhatsAppActorId(value: unknown): string {
  const actorId = requireNonEmptyString(value, "WhatsApp actor is required.");
  const jidMatch = actorId.match(/^(\d{8,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/i);
  const jidDigits = jidMatch?.[1];
  const jidDomain = jidMatch?.[2];
  if (jidDigits && jidDomain) return `${jidDigits}@${jidDomain.toLowerCase()}`;

  const digits = actorId.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("WhatsApp actor must be a phone number, @s.whatsapp.net JID, or @lid JID.");
  }
  return `${digits}@s.whatsapp.net`;
}

function controlChannelActorId(source: ControlChannelActorPairingSource, value: unknown): string {
  return source === "telegram" ? controlTelegramActorId(value) : controlWhatsAppActorId(value);
}

function controlRuntimeModel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Session runtime model must be a string.");
  const trimmed = value.trim();
  return trimmed && trimmed !== "default" ? trimmed : null;
}

function controlRuntimeThinking(value: unknown): {
  thinking: ThinkingLevel | null;
  thinkingConfigured: boolean;
} | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "default") {
    return {thinking: null, thinkingConfigured: false};
  }
  if (value === "off") {
    return {thinking: null, thinkingConfigured: true};
  }
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return {thinking: value, thinkingConfigured: true};
  }
  throw new Error("Session runtime thinking must be default, off, low, medium, high, or xhigh.");
}

function includesSearch(row: Record<string, unknown>, search: string): boolean {
  if (!search) return true;
  return Object.values(row).some((value) => sortText(value).includes(search));
}

function searchRank(search: string, title: string, subtitle: string): number {
  const normalizedTitle = title.toLowerCase();
  const normalizedSubtitle = subtitle.toLowerCase();
  if (normalizedTitle === search) return 0;
  if (normalizedTitle.startsWith(search)) return 1;
  if (normalizedTitle.includes(search)) return 2;
  if (normalizedSubtitle.includes(search)) return 3;
  return 4;
}

async function searchTableRows<T>(load: Promise<ControlPaginatedResponse<T>>): Promise<T[]> {
  try {
    return (await load).data;
  } catch {
    return [];
  }
}

function searchResultKindWeight(kind: ControlGlobalSearchResult["kind"]): number {
  return [
    "agent",
    "session",
    "identity",
    "work_failure",
    "credential",
    "connector",
    "binding",
    "skill",
    "subagent",
    "gateway_source",
    "gateway_device",
  ].indexOf(kind);
}

async function tableExists(pool: PgQueryable, relation: string): Promise<boolean> {
  const [schema, table] = relation.replaceAll("\"", "").split(".");
  const result = await pool.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_name = $2
    LIMIT 1
  `, [schema, table]);
  return result.rows.length > 0;
}

export class ControlOperatorService {
  private readonly pool: PgQueryable;
  private readonly reads: Pick<ControlReadService, "listAgents" | "listAuditEvents">;
  private readonly a2aBindings: ControlA2ABindingStore;
  private readonly agents: AgentStore;
  private readonly sessions: SessionStore;
  private readonly threads: Pick<ThreadRuntimeStore, "createThread">;
  private readonly identities: ControlOperatorServiceOptions["identities"];
  private readonly credentials: CredentialService | null;
  private readonly email: ControlEmailStore;
  private readonly connectorAccounts: PostgresConnectorAccountStore;
  private readonly connectorCrypto: CredentialCrypto | null;
  private readonly conversations: ConversationRepo;
  private readonly gateway: PostgresGatewayStore;
  private readonly subagents: SubagentProfileStore;
  private readonly wikiBindings: ControlWikiBindings;
  private readonly telegramBotIdentityClient: ControlTelegramBotIdentityClient | null;
  private readonly sessionTables = buildSessionTableNames();
  private readonly threadTables = buildThreadRuntimeTableNames();
  private readonly scheduledTables = buildScheduledTaskTableNames();
  private readonly deliveryTables = buildOutboundDeliveryTableNames();
  private readonly credentialTables = buildCredentialTableNames();
  private readonly connectorTables = buildConnectorAccountTableNames();
  private readonly conversationTables = buildConversationSessionTableNames();
  private readonly gatewayTables = buildGatewayTableNames();

  constructor(options: ControlOperatorServiceOptions) {
    this.pool = options.pool;
    this.reads = options.reads;
    this.a2aBindings = options.a2aBindings;
    this.agents = options.agents;
    this.sessions = options.sessions;
    this.threads = options.threads;
    this.identities = options.identities;
    this.credentials = options.credentials;
    this.email = options.email;
    this.connectorAccounts = options.connectorAccounts;
    this.connectorCrypto = options.connectorCrypto;
    this.conversations = options.conversations;
    this.gateway = options.gateway;
    this.subagents = options.subagents;
    this.wikiBindings = options.wikiBindings;
    this.telegramBotIdentityClient = options.telegramBotIdentityClient ?? null;
  }

  private async assertAgentVisible(session: ControlSessionRecord, agentKey: string): Promise<string> {
    const normalized = requireNonEmptyString(agentKey, "Agent key is required.");
    const visible = await this.reads.listAgents(session);
    if (!visible.some((agent) => agent.agentKey === normalized)) {
      throw new Error("Control target agent was not found or is not visible.");
    }
    return normalized;
  }

  private assertAdmin(session: ControlSessionRecord): void {
    if (session.role !== "admin") {
      throw new Error("Control identity management requires admin access.");
    }
  }

  private async visibleIdentityIds(session: ControlSessionRecord): Promise<Set<string> | null> {
    if (session.role === "admin") return null;
    const visibleAgents = await this.reads.listAgents(session);
    const pairings = await Promise.all(
      visibleAgents.map((agent) => this.agents.listAgentPairings(agent.agentKey).catch(() => [] as readonly AgentPairingRecord[])),
    );
    return new Set(pairings.flat().map((pairing) => pairing.identityId));
  }

  private async assertSessionVisible(session: ControlSessionRecord, agentKey: string, sessionId: string): Promise<SessionRecord> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const target = await this.sessions.getSession(requireNonEmptyString(sessionId, "Session id is required."));
    if (target.agentKey !== normalizedAgentKey) {
      throw new Error("Control target session was not found or is not visible.");
    }
    return target;
  }

  private async assertAnyVisibleSession(session: ControlSessionRecord, sessionId: string): Promise<SessionRecord> {
    const target = await this.sessions.getSession(requireNonEmptyString(sessionId, "Session id is required."));
    await this.assertAgentVisible(session, target.agentKey);
    return target;
  }

  private async getAgentConnectorAccount(session: ControlSessionRecord, agentKey: string, source: string, accountKey: string, input: {
    requireEnabled?: boolean;
  } = {}): Promise<{agentKey: string; account: ConnectorAccountRecord}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedAccountKey = requireNonEmptyString(accountKey, "Connector account key is required.");
    const account = await this.connectorAccounts.getAccountByKey(source, normalizedAccountKey);
    if (!account || account.ownerKind !== "agent" || account.ownerAgentKey !== normalizedAgentKey) {
      throw new Error("Control connector account was not found or is not visible.");
    }
    if (input.requireEnabled && account.status !== "enabled") {
      throw new Error(`Control ${source} account ${account.accountKey} is ${account.status}; enable it before pairing actors.`);
    }
    return {agentKey: normalizedAgentKey, account};
  }

  private async resolveIdentity(input: {identityId?: unknown; identityHandle?: unknown}): Promise<IdentityRecord> {
    const identityId = typeof input.identityId === "string" ? trimToUndefined(input.identityId) : undefined;
    const identityHandle = typeof input.identityHandle === "string" ? trimToUndefined(input.identityHandle) : undefined;
    const identity = identityId
      ? await this.identities.getIdentity(identityId)
      : identityHandle
        ? await this.identities.getIdentityByHandle(identityHandle)
        : undefined;
    if (!identity) {
      throw new Error("Identity is required.");
    }
    if (identity.status !== "active") {
      throw new Error("Control can only pair active identities.");
    }
    return identity;
  }

  private async assertIdentityPairedToAgent(agentKey: string, identityId: string): Promise<void> {
    const pairings = await this.agents.listAgentPairings(agentKey);
    if (!pairings.some((pairing) => pairing.identityId === identityId)) {
      throw new Error("Control channel actor pairing identity must already be paired with the target agent.");
    }
  }

  async listAgents(session: ControlSessionRecord, input: ControlTableInput = {}): Promise<ControlPaginatedResponse<ControlAgentRow>> {
    const search = normalizeSearch(input.search);
    const rows = (await this.reads.listAgents(session)).filter((agent) => includesSearch(agent as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows, input, "agentKey"), input);
  }

  async search(session: ControlSessionRecord, input: ControlTableInput = {}): Promise<ControlPaginatedResponse<ControlGlobalSearchResult>> {
    const search = normalizeSearch(input.search);
    if (!search) return tableResponse([], {...input, perPage: input.perPage ?? 8});

    const agents = await this.reads.listAgents(session);
    const results: Array<ControlGlobalSearchResult & {rank: number}> = [];
    const addResult = (result: ControlGlobalSearchResult, rankTitle = result.title, rankSubtitle = result.subtitle) => {
      results.push({...result, rank: searchRank(search, rankTitle, rankSubtitle)});
    };

    for (const failure of await searchTableRows(this.listWorkFailures(session, {search, perPage: 25}))) {
      addResult({
        id: `work-failure:${failure.id}`,
        kind: "work_failure",
        title: failure.summary,
        subtitle: `${failure.severity} · ${failure.source} · ${failure.agentKey}`,
        targetRoute: failure.targetRoute,
        agentKey: failure.agentKey,
        ...(failure.sessionId ? {sessionId: failure.sessionId} : {}),
        updatedAt: failure.createdAt,
      }, failure.summary, `${failure.source} ${failure.agentKey} ${failure.sessionLabel ?? ""} ${failure.detail ?? ""}`);
    }

    for (const identity of await searchTableRows(this.listIdentities(session, {search, perPage: 25}))) {
      addResult({
        id: `identity:${identity.id}`,
        kind: "identity",
        title: identity.displayName || identity.handle,
        subtitle: `${identity.handle} · ${identity.status} identity`,
        targetRoute: `/identities?search=${encodeURIComponent(identity.handle)}`,
        updatedAt: identity.updatedAt,
      }, identity.displayName || identity.handle, `${identity.handle} ${identity.status}`);
    }

    for (const agent of agents) {
      const subtitle = `${agent.status} · ${agent.sessionCount} sessions`;
      if (includesSearch(agent as unknown as Record<string, unknown>, search)) {
        addResult({
          id: `agent:${agent.agentKey}`,
          kind: "agent",
          title: agent.displayName || agent.agentKey,
          subtitle,
          targetRoute: `/agents/${encodeURIComponent(agent.agentKey)}`,
          agentKey: agent.agentKey,
        }, agent.displayName || agent.agentKey, `${agent.agentKey} ${subtitle}`);
      }

      const sessions = await this.sessions.listAgentSessions(agent.agentKey);
      for (const rawSession of sessions) {
        const row = publicSessionRow(rawSession);
        const searchable = {
          id: row.id,
          label: row.label,
          alias: row.alias,
          displayName: row.displayName,
          agentKey: row.agentKey,
          kind: row.kind,
          currentThreadId: row.currentThreadId,
        };
        if (!includesSearch(searchable as Record<string, unknown>, search)) continue;
        const sessionSubtitle = `${row.agentKey} · ${row.kind}`;
        addResult({
          id: `session:${row.id}`,
          kind: "session",
          title: row.label,
          subtitle: sessionSubtitle,
          targetRoute: `/agents/${encodeURIComponent(row.agentKey)}/sessions/${encodeURIComponent(row.id)}`,
          agentKey: row.agentKey,
          sessionId: row.id,
          updatedAt: row.updatedAt,
        }, row.label, `${row.id} ${sessionSubtitle}`);
      }

      const agentRoute = `/agents/${encodeURIComponent(agent.agentKey)}`;
      const [credentials, connectors, bindings, skills, subagents, gatewaySources] = await Promise.all([
        searchTableRows(this.listCredentials(session, agent.agentKey, {search, perPage: 100})),
        searchTableRows(this.listConnectors(session, agent.agentKey, {search, perPage: 100})),
        searchTableRows(this.listBindings(session, agent.agentKey, {search, perPage: 100})),
        searchTableRows(this.listSkills(session, agent.agentKey, {search, perPage: 100})),
        searchTableRows(this.listSubagents(session, agent.agentKey, {search, perPage: 100})),
        searchTableRows(this.listGatewaySources(session, agent.agentKey, {perPage: 100})),
      ]);

      for (const row of credentials) {
        if (!includesSearch({envKey: row.envKey}, search)) continue;
        addResult({
          id: `credential:${row.agentKey}:${row.envKey}`,
          kind: "credential",
          title: row.envKey,
          subtitle: `${row.agentKey} · credential`,
          targetRoute: `${agentRoute}?tab=credentials`,
          agentKey: row.agentKey,
          updatedAt: row.updatedAt,
        });
      }

      for (const row of connectors) {
        const searchable = {
          source: row.source,
          accountKey: row.accountKey,
          connectorKey: row.connectorKey,
          displayName: row.displayName,
          externalUsername: row.externalUsername,
          status: row.status,
          secretKeys: row.secretKeys,
        };
        if (!includesSearch(searchable, search)) continue;
        const title = row.displayName || row.accountKey;
        addResult({
          id: `connector:${row.source}:${row.accountKey}`,
          kind: "connector",
          title,
          subtitle: `${agent.agentKey} · ${row.source}/${row.connectorKey} · ${row.status}`,
          targetRoute: `${agentRoute}?tab=connectors`,
          agentKey: agent.agentKey,
          updatedAt: row.updatedAt,
        }, title, `${row.accountKey} ${row.connectorKey} ${row.source} ${row.externalUsername ?? ""} ${row.status}`);
      }

      for (const row of bindings) {
        const searchable = {
          source: row.source,
          connectorKey: row.connectorKey,
          externalConversationId: row.externalConversationId,
          displayName: row.displayName,
          sessionLabel: row.sessionLabel,
        };
        if (!includesSearch(searchable, search)) continue;
        const title = row.displayName || row.externalConversationId;
        addResult({
          id: `binding:${row.source}:${row.connectorKey}:${row.externalConversationId}`,
          kind: "binding",
          title,
          subtitle: `${agent.agentKey} · ${row.source}/${row.connectorKey} · ${row.sessionLabel}`,
          targetRoute: `/agents/${encodeURIComponent(agent.agentKey)}/sessions/${encodeURIComponent(row.sessionId)}?tab=bindings`,
          agentKey: agent.agentKey,
          sessionId: row.sessionId,
          updatedAt: row.updatedAt,
        }, title, `${row.externalConversationId} ${row.connectorKey} ${row.sessionLabel}`);
      }

      for (const row of skills) {
        if (!includesSearch({skillKey: row.skillKey, description: row.description}, search)) continue;
        addResult({
          id: `skill:${row.agentKey}:${row.skillKey}`,
          kind: "skill",
          title: row.skillKey,
          subtitle: `${row.agentKey} · skill`,
          targetRoute: `${agentRoute}?tab=skills`,
          agentKey: row.agentKey,
          updatedAt: row.updatedAt,
        }, row.skillKey, row.description);
      }

      for (const row of subagents) {
        const searchable = {
          slug: row.slug,
          description: row.description,
          toolGroups: row.toolGroups,
          model: row.model,
          source: row.source,
          enabled: row.enabled ? "enabled" : "disabled",
        };
        if (!includesSearch(searchable, search)) continue;
        addResult({
          id: `subagent:${agent.agentKey}:${row.slug}`,
          kind: "subagent",
          title: row.slug,
          subtitle: `${agent.agentKey} · subagent · ${row.enabled ? "enabled" : "disabled"}`,
          targetRoute: `${agentRoute}?tab=subagents`,
          agentKey: agent.agentKey,
          updatedAt: row.updatedAt,
        }, row.slug, row.description);
      }

      for (const row of gatewaySources) {
        const searchable = {
          sourceId: row.sourceId,
          name: row.name,
          clientId: row.clientId,
          status: row.status,
          sessionId: row.sessionId,
        };
        if (includesSearch(searchable, search)) {
          addResult({
            id: `gateway-source:${row.sourceId}`,
            kind: "gateway_source",
            title: row.name || row.sourceId,
            subtitle: `${row.agentKey} · gateway source · ${row.status}`,
            targetRoute: `${agentRoute}?tab=gateway`,
            agentKey: row.agentKey,
            ...(row.sessionId ? {sessionId: row.sessionId} : {}),
            updatedAt: row.updatedAt,
          }, row.name || row.sourceId, `${row.sourceId} ${row.status} ${row.sessionId ?? ""}`);
        }

        const devices = await this.listGatewayDevices(session, agent.agentKey, row.sourceId, {
          perPage: 100,
          sortBy: "deviceId",
          sortDirection: "asc",
        }).catch(() => ({data: [] as ControlGatewayDeviceRow[], meta: {current_page: 1, last_page: 1, per_page: 100, total: 0}}));
        for (const device of devices.data) {
          const deviceSearchable = {
            sourceId: device.sourceId,
            deviceId: device.deviceId,
            label: device.label,
            capabilities: device.capabilities,
            enabled: device.enabled ? "enabled" : "disabled",
          };
          if (!includesSearch(deviceSearchable, search)) continue;
          addResult({
            id: `gateway-device:${device.sourceId}:${device.deviceId}`,
            kind: "gateway_device",
            title: device.label || device.deviceId,
            subtitle: `${agent.agentKey} · ${device.sourceId} · ${device.enabled ? "enabled" : "disabled"}`,
            targetRoute: `${agentRoute}?tab=gateway`,
            agentKey: agent.agentKey,
            updatedAt: device.updatedAt,
          }, device.label || device.deviceId, `${device.sourceId} ${device.capabilities.join(" ")}`);
        }
      }
    }

    const sorted = results
      .sort((left, right) => left.rank - right.rank || searchResultKindWeight(left.kind) - searchResultKindWeight(right.kind) || left.title.localeCompare(right.title))
      .map((result): ControlGlobalSearchResult => ({
        id: result.id,
        kind: result.kind,
        title: result.title,
        subtitle: result.subtitle,
        targetRoute: result.targetRoute,
        ...(result.agentKey ? {agentKey: result.agentKey} : {}),
        ...(result.sessionId ? {sessionId: result.sessionId} : {}),
        ...(result.updatedAt ? {updatedAt: result.updatedAt} : {}),
      }));
    return tableResponse(sorted, {...input, perPage: input.perPage ?? 8});
  }

  async getAgent(session: ControlSessionRecord, agentKey: string): Promise<ControlAgentDetail> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const agent = (await this.reads.listAgents(session)).find((candidate) => candidate.agentKey === normalizedAgentKey);
    if (!agent) throw new Error("Control target agent was not found or is not visible.");
    const [connectorResult, pairingRows, skillRows, subagentRows, gatewaySources, wikiBinding] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.connectorTables.connectorAccounts} WHERE owner_kind = 'agent' AND owner_agent_key = $1`, [normalizedAgentKey]).catch(() => ({rows: [{count: 0}]})),
      this.agents.listAgentPairings(normalizedAgentKey).catch(() => [] as readonly AgentPairingRecord[]),
      this.agents.listAgentSkills(normalizedAgentKey).catch(() => [] as readonly AgentSkillRecord[]),
      this.subagents.listProfiles({agentKey: normalizedAgentKey, includeDisabled: true}).catch(() => [] as readonly SubagentProfileRecord[]),
      this.gateway.listSources().catch(() => [] as readonly GatewaySourceRecord[]),
      this.wikiBindings.store.getBinding(normalizedAgentKey).catch(() => null),
    ]);
    const credentials = await this.listCredentials(session, normalizedAgentKey);
    return {
      ...agent,
      credentialCount: credentials.meta.total,
      connectorCount: Number((connectorResult.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      pairingCount: pairingRows.length,
      skillCount: skillRows.length,
      subagentCount: subagentRows.length,
      gatewaySourceCount: gatewaySources.filter((source) => source.agentKey === normalizedAgentKey).length,
      wikiBindingSet: Boolean(wikiBinding),
    };
  }

  async listIdentities(session: ControlSessionRecord, input: ControlIdentityTableInput = {}): Promise<ControlPaginatedResponse<ControlIdentityOptionRow>> {
    const search = normalizeSearch(input.search);
    const visibleIdentityIds = await this.visibleIdentityIds(session);
    const [identities, visibleAgents] = await Promise.all([
      this.identities.listIdentities(),
      this.reads.listAgents(session),
    ]);
    const pairings = await Promise.all(
      visibleAgents.map((agent) => this.agents.listAgentPairings(agent.agentKey).catch(() => [] as readonly AgentPairingRecord[])),
    );
    const agentPairingCounts = new Map<string, number>();
    for (const pairing of pairings.flat()) {
      agentPairingCounts.set(pairing.identityId, (agentPairingCounts.get(pairing.identityId) ?? 0) + 1);
    }
    const actorBindingCounts = new Map<string, number>();
    await Promise.all(identities.map(async (identity) => {
      if (visibleIdentityIds && !visibleIdentityIds.has(identity.id)) return;
      const bindings = await this.identities.listIdentityBindings(identity.id).catch(() => [] as readonly IdentityBindingRecord[]);
      actorBindingCounts.set(identity.id, bindings.length);
    }));

    const status = typeof input.status === "string" ? trimToUndefined(input.status) : undefined;
    const rows = identities
      .filter((identity) => !visibleIdentityIds || visibleIdentityIds.has(identity.id))
      .filter((identity) => !status || identity.status === status)
      .map((identity) => publicIdentityOption(identity, {
        agentPairingCount: agentPairingCounts.get(identity.id) ?? 0,
        actorBindingCount: actorBindingCounts.get(identity.id) ?? 0,
      }))
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "handle") as unknown as ControlIdentityOptionRow[], input);
  }

  async createIdentity(session: ControlSessionRecord, input: {
    handle?: unknown;
    displayName?: unknown;
  }): Promise<{identity: ControlIdentityOptionRow; audit: Record<string, unknown>}> {
    this.assertAdmin(session);
    const handle = normalizeIdentityHandle(requireNonEmptyString(input.handle, "Identity handle is required."));
    const displayName = typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : handle;
    const identity = await this.identities.createIdentity({
      id: randomUUID(),
      handle,
      displayName,
    });
    return {
      identity: publicIdentityOption(identity),
      audit: {
        action: "create_identity",
        identityHandle: identity.handle,
        displayName: identity.displayName,
        status: identity.status,
      },
    };
  }

  async updateIdentity(session: ControlSessionRecord, identityIdInput: string, input: {
    displayName?: unknown;
    status?: unknown;
  }): Promise<{identity: ControlIdentityOptionRow; audit: Record<string, unknown>}> {
    this.assertAdmin(session);
    const identityId = requireNonEmptyString(identityIdInput, "Identity id is required.");
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : undefined;
    const status = input.status === "active" || input.status === "deleted" ? input.status : undefined;
    if (input.status !== undefined && !status) {
      throw new Error("Identity status must be active or deleted.");
    }
    const identity = await this.identities.updateIdentity({
      identityId,
      ...(displayName !== undefined ? {displayName} : {}),
      ...(status ? {status} : {}),
    });
    return {
      identity: publicIdentityOption(identity),
      audit: {
        action: "update_identity",
        identityHandle: identity.handle,
        ...(displayName !== undefined ? {displayName: identity.displayName} : {}),
        ...(status ? {status: identity.status} : {}),
      },
    };
  }

  async disableIdentity(session: ControlSessionRecord, identityIdInput: string): Promise<{identity: ControlIdentityOptionRow; audit: Record<string, unknown>}> {
    const result = await this.updateIdentity(session, identityIdInput, {status: "deleted"});
    return {
      identity: result.identity,
      audit: {
        ...result.audit,
        action: "disable_identity",
      },
    };
  }

  async listAgentPairings(session: ControlSessionRecord, agentKey: string, input: ControlAgentPairingTableInput = {}): Promise<ControlPaginatedResponse<ControlAgentPairingRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const search = normalizeSearch(input.search);
    const pairings = await this.agents.listAgentPairings(normalizedAgentKey);
    const identities = await Promise.all(pairings.map((pairing) => this.identities.getIdentity(pairing.identityId).catch(() => null)));
    const identityById = new Map(identities.filter((identity): identity is IdentityRecord => Boolean(identity)).map((identity) => [identity.id, identity]));
    const status = typeof input.status === "string" ? trimToUndefined(input.status) : undefined;
    const rows = pairings
      .map((pairing) => {
        const identity = identityById.get(pairing.identityId);
        return identity ? publicAgentPairing(pairing, identity) : null;
      })
      .filter((row): row is ControlAgentPairingRow => Boolean(row))
      .filter((row) => !status || row.identityStatus === status)
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "identityHandle") as unknown as ControlAgentPairingRow[], input);
  }

  async pairAgentIdentity(session: ControlSessionRecord, agentKey: string, input: {identityId?: unknown; identityHandle?: unknown}): Promise<{pairing: ControlAgentPairingRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    await this.agents.getAgent(normalizedAgentKey);
    const identity = await this.resolveIdentity({
      identityId: input.identityId,
      identityHandle: input.identityHandle,
    });
    const pairing = await this.agents.ensurePairing(normalizedAgentKey, identity.id);
    return {
      pairing: publicAgentPairing(pairing, identity),
      audit: {
        action: "pair_agent_identity",
        agentKey: normalizedAgentKey,
        identityId: identity.id,
        identityHandle: identity.handle,
      },
    };
  }

  async deleteAgentPairing(session: ControlSessionRecord, agentKey: string, identityIdInput: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const identityId = requireNonEmptyString(identityIdInput, "Identity id is required.");
    const identity = await this.identities.getIdentity(identityId);
    const deleted = await this.agents.deletePairing(normalizedAgentKey, identity.id);
    return {
      deleted,
      audit: {
        action: "delete_agent_identity_pairing",
        agentKey: normalizedAgentKey,
        identityId: identity.id,
        identityHandle: identity.handle,
      },
    };
  }

  async listSessions(session: ControlSessionRecord, agentKey: string, input: ControlSessionTableInput = {}): Promise<ControlPaginatedResponse<ControlSessionRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const search = normalizeSearch(input.search);
    const sessionRows = await this.sessions.listAgentSessions(normalizedAgentKey);
    const heartbeats = await this.pool.query(`
      SELECT session_id, enabled
      FROM ${this.sessionTables.sessionHeartbeats}
      WHERE session_id = ANY($1::text[])
    `, [sessionRows.map((row) => row.id)]).catch(() => ({rows: []}));
    const heartbeatBySession = new Map((heartbeats.rows as Array<Record<string, unknown>>).map((row) => [String(row.session_id), row.enabled !== false]));
    const visibility = input.visibility ?? "primary";
    const rows = sessionRows
      .map((row) => publicSessionRow(row, heartbeatBySession.get(row.id) ?? row.kind === "main"))
      .filter((row) => {
        if (visibility === "all") return true;
        return visibility === "subagent" ? row.isSubagent : !row.isSubagent;
      })
      .filter((row) => !input.kind || row.kind === input.kind)
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "updatedAt") as unknown as ControlSessionRow[], input);
  }

  async getSession(session: ControlSessionRecord, agentKey: string, sessionId: string): Promise<ControlSessionDetail> {
    const target = await this.assertSessionVisible(session, agentKey, sessionId);
    const [heartbeat, briefing, runtime] = await Promise.all([
      this.sessions.getHeartbeat(target.id),
      this.sessions.readSessionPrompt(target.id),
      this.sessions.getSessionRuntimeConfig(target.id).catch(() => null),
    ]);
    return {
      ...publicSessionRow(target, heartbeat?.enabled ?? target.kind === "main"),
      briefingSet: Boolean(briefing?.content.trim()),
      runtime: {
        ...(runtime?.model ? {model: runtime.model} : {}),
        ...(runtime?.thinking ? {thinking: runtime.thinking} : {}),
        thinkingConfigured: runtime?.thinkingConfigured ?? false,
        ...(runtime?.pendingWakeAt ? {pendingWakeAt: iso(runtime.pendingWakeAt)} : {}),
      },
    };
  }

  async createSession(session: ControlSessionRecord, agentKey: string, input: {
    kind?: unknown;
    alias?: unknown;
    displayName?: unknown;
  }): Promise<{session: ControlSessionRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const kind = controlCreateSessionKind(input.kind);
    const alias = typeof input.alias === "string" && input.alias.trim() ? normalizeSessionAlias(input.alias) : undefined;
    const displayName = typeof input.displayName === "string" ? trimToUndefined(input.displayName) : undefined;
    const sessionId = randomUUID();
    const threadId = randomUUID();
    const created = await this.sessions.createSession({
      id: sessionId,
      agentKey: normalizedAgentKey,
      kind,
      currentThreadId: threadId,
      createdByIdentityId: session.identityId,
      ...(alias ? {alias} : {}),
      ...(displayName ? {displayName} : {}),
    });
    return {
      session: publicSessionRow(created, kind === "main"),
      audit: {
        action: "create",
        agentKey: normalizedAgentKey,
        targetSessionId: created.id,
        kind,
        alias: alias ?? null,
        displayName: displayName ?? null,
      },
    };
  }

  async updateSessionLabel(session: ControlSessionRecord, agentKey: string, sessionId: string, input: {
    alias?: unknown;
    displayName?: unknown;
  }): Promise<{session: ControlSessionRow; audit: Record<string, unknown>}> {
    const target = await this.assertSessionVisible(session, agentKey, sessionId);
    const updated = await this.sessions.updateSessionLabel({
      sessionId: target.id,
      ...(input.alias === null || typeof input.alias === "string" ? {alias: input.alias === null ? null : normalizeSessionAlias(input.alias)} : {}),
      ...(input.displayName === null || typeof input.displayName === "string" ? {displayName: input.displayName === null ? null : trimToUndefined(input.displayName) ?? null} : {}),
    });
    return {
      session: publicSessionRow(updated),
      audit: {
        action: "update_label",
        agentKey,
        targetSessionId: updated.id,
        alias: updated.alias ?? null,
        displayName: updated.displayName ?? null,
      },
    };
  }

  async updateSessionRuntimeConfig(session: ControlSessionRecord, agentKey: string, sessionId: string, input: {
    model?: unknown;
    thinking?: unknown;
  }): Promise<{session: ControlSessionDetail; audit: Record<string, unknown>}> {
    const target = await this.assertSessionVisible(session, agentKey, sessionId);
    const model = controlRuntimeModel(input.model);
    const thinking = controlRuntimeThinking(input.thinking);
    if (model === undefined && thinking === undefined) {
      throw new Error("No session runtime config fields were provided.");
    }

    await this.sessions.updateSessionRuntimeConfig({
      sessionId: target.id,
      ...(model !== undefined ? {model} : {}),
      ...(thinking !== undefined ? {
        thinking: thinking.thinking,
        thinkingConfigured: thinking.thinkingConfigured,
      } : {}),
    });
    const updated = await this.getSession(session, target.agentKey, target.id);
    const thinkingMode = updated.runtime.thinking
      ?? (updated.runtime.thinkingConfigured ? "off" : "default");
    return {
      session: updated,
      audit: {
        action: "update_runtime_config",
        agentKey: target.agentKey,
        targetSessionId: target.id,
        model: updated.runtime.model ?? null,
        thinking: thinkingMode,
      },
    };
  }

  async resetSession(session: ControlSessionRecord, agentKey: string, sessionId: string): Promise<{session: ControlSessionRow; previousThreadId: string; audit: Record<string, unknown>}> {
    const target = await this.assertSessionVisible(session, agentKey, sessionId);
    const nextThreadId = randomUUID();
    await this.threads.createThread({id: nextThreadId, sessionId: target.id});
    const updated = await this.sessions.updateCurrentThread({sessionId: target.id, currentThreadId: nextThreadId});
    return {
      session: publicSessionRow(updated),
      previousThreadId: target.currentThreadId,
      audit: {
        action: "reset",
        agentKey,
        targetSessionId: updated.id,
        previousThreadId: target.currentThreadId,
        nextThreadId,
      },
    };
  }

  async listCredentials(session: ControlSessionRecord, agentKey: string, input: ControlTableInput = {}): Promise<ControlPaginatedResponse<ControlCredentialRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const rows = await this.pool.query(`
      SELECT agent_key, env_key, created_at, updated_at
      FROM ${this.credentialTables.credentials}
      WHERE agent_key = $1
      ORDER BY env_key ASC
    `, [normalizedAgentKey]);
    const search = normalizeSearch(input.search);
    const mapped = (rows.rows as Array<Record<string, unknown>>)
      .map((row) => ({
        agentKey: String(row.agent_key),
        envKey: String(row.env_key),
        present: true as const,
        createdAt: iso(row.created_at as Date)!,
        updatedAt: iso(row.updated_at as Date)!,
      }))
      .filter((row) => includesSearch(row, search));
    return tableResponse(sortRows(mapped, input, "envKey"), input);
  }

  async setCredential(session: ControlSessionRecord, agentKey: string, input: {
    envKey?: unknown;
    value?: unknown;
  }): Promise<{credential: ControlCredentialRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    if (!this.credentials) {
      throw new Error("CREDENTIALS_MASTER_KEY is required to write credentials.");
    }
    const envKey = requireNonEmptyString(input.envKey, "Credential env key is required.");
    const value = requireNonEmptyString(input.value, "Credential value is required.");
    const record = await this.credentials.setCredential({agentKey: normalizedAgentKey, envKey, value});
    return {
      credential: {
        agentKey: record.agentKey,
        envKey: record.envKey,
        present: true,
        createdAt: iso(record.createdAt)!,
        updatedAt: iso(record.updatedAt)!,
      },
      audit: {
        action: "set",
        agentKey: normalizedAgentKey,
        envKey: record.envKey,
        secret: secretSummary(value),
      },
    };
  }

  async deleteCredential(session: ControlSessionRecord, agentKey: string, envKey: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    if (!this.credentials) {
      throw new Error("CREDENTIALS_MASTER_KEY is required to delete credentials.");
    }
    const deleted = await this.credentials.clearCredential({agentKey: normalizedAgentKey, envKey});
    return {
      deleted,
      audit: {
        action: "delete",
        agentKey: normalizedAgentKey,
        envKey,
      },
    };
  }

  async listConnectors(session: ControlSessionRecord, agentKey: string, input: ControlConnectorTableInput = {}): Promise<ControlPaginatedResponse<ControlConnectorRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accounts = await this.connectorAccounts.listAccounts({ownerKind: "agent"});
    const rows = await Promise.all(accounts
      .filter((account) => account.ownerAgentKey === normalizedAgentKey)
      .map(async (account) => publicConnector(account, (await this.connectorAccounts.listSecretKeys(account.id)).map((secret) => secret.secretKey))));
    const search = normalizeSearch(input.search);
    const filtered = rows.filter((row) =>
      (!input.source || row.source === input.source)
      && (!input.status || row.status === input.status)
      && includesSearch(row as unknown as Record<string, unknown>, search)
    );
    return tableResponse(sortRows(filtered as unknown as Record<string, unknown>[], input, "accountKey") as unknown as ControlConnectorRow[], input);
  }

  async upsertDiscordConnector(session: ControlSessionRecord, agentKey: string, input: {
    accountKey?: unknown;
    connectorKey?: unknown;
    displayName?: unknown;
    botToken?: unknown;
  }): Promise<{connector: ControlConnectorRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accountKey = requireNonEmptyString(input.accountKey, "Discord account key is required.");
    const connectorKey = requireNonEmptyString(input.connectorKey, "Discord connector key is required.");
    const botToken = typeof input.botToken === "string" && input.botToken.trim() ? input.botToken : undefined;
    const account = await this.connectorAccounts.upsertAccount({
      source: "discord",
      accountKey,
      connectorKey,
      ownerKind: "agent",
      ownerAgentKey: normalizedAgentKey,
      displayName: typeof input.displayName === "string" ? trimToUndefined(input.displayName) : undefined,
      status: "enabled",
    });
    if (botToken) {
      await this.connectorAccounts.setSecret(account.id, "bot_token", botToken, this.connectorCrypto);
    }
    const secretKeys = (await this.connectorAccounts.listSecretKeys(account.id)).map((secret) => secret.secretKey);
    return {
      connector: publicConnector(account, secretKeys),
      audit: {
        action: "upsert_discord",
        agentKey: normalizedAgentKey,
        accountKey: account.accountKey,
        connectorKey: account.connectorKey,
        secret: botToken ? secretSummary(botToken) : null,
      },
    };
  }

  async upsertEmailConnector(session: ControlSessionRecord, agentKey: string, input: {
    accountKey?: unknown;
    displayName?: unknown;
    fromAddress?: unknown;
    fromName?: unknown;
    mailboxes?: unknown;
    imapHost?: unknown;
    imapPort?: unknown;
    imapSecure?: unknown;
    imapUsername?: unknown;
    imapPassword?: unknown;
    smtpHost?: unknown;
    smtpPort?: unknown;
    smtpSecure?: unknown;
    smtpUsername?: unknown;
    smtpPassword?: unknown;
  }): Promise<{connector: ControlConnectorRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accountKey = requireNonEmptyString(input.accountKey, "Email account key is required.");
    const existing = await existingEmailAccount(this.email, normalizedAgentKey, accountKey);
    const fromAddress = requireNonEmptyString(input.fromAddress, "From address is required.");
    const fromName = typeof input.fromName === "string" ? trimToUndefined(input.fromName) : undefined;
    const displayName = typeof input.displayName === "string" ? trimToUndefined(input.displayName) : undefined;
    const imapUsername = typeof input.imapUsername === "string" && input.imapUsername.trim() ? input.imapUsername : undefined;
    const imapPassword = typeof input.imapPassword === "string" && input.imapPassword.trim() ? input.imapPassword : undefined;
    const smtpUsername = typeof input.smtpUsername === "string" && input.smtpUsername.trim() ? input.smtpUsername : undefined;
    const smtpPassword = typeof input.smtpPassword === "string" && input.smtpPassword.trim() ? input.smtpPassword : undefined;

    if (!existing && (!imapUsername || !imapPassword || !smtpUsername || !smtpPassword)) {
      throw new Error("Email username and password fields are required when creating an email account.");
    }
    if ((imapUsername || imapPassword || smtpUsername || smtpPassword) && !this.credentials) {
      throw new Error("CREDENTIALS_MASTER_KEY is required to write email connector credentials.");
    }

    const imapUsernameCredentialEnvKey = existing?.imap.usernameCredentialEnvKey ?? emailCredentialEnvKey(accountKey, "imap", "username");
    const imapPasswordCredentialEnvKey = existing?.imap.passwordCredentialEnvKey ?? emailCredentialEnvKey(accountKey, "imap", "password");
    const smtpUsernameCredentialEnvKey = existing?.smtp.usernameCredentialEnvKey ?? emailCredentialEnvKey(accountKey, "smtp", "username");
    const smtpPasswordCredentialEnvKey = existing?.smtp.passwordCredentialEnvKey ?? emailCredentialEnvKey(accountKey, "smtp", "password");

    await Promise.all([
      imapUsername ? this.credentials!.setCredential({agentKey: normalizedAgentKey, envKey: imapUsernameCredentialEnvKey, value: imapUsername}) : Promise.resolve(),
      imapPassword ? this.credentials!.setCredential({agentKey: normalizedAgentKey, envKey: imapPasswordCredentialEnvKey, value: imapPassword}) : Promise.resolve(),
      smtpUsername ? this.credentials!.setCredential({agentKey: normalizedAgentKey, envKey: smtpUsernameCredentialEnvKey, value: smtpUsername}) : Promise.resolve(),
      smtpPassword ? this.credentials!.setCredential({agentKey: normalizedAgentKey, envKey: smtpPasswordCredentialEnvKey, value: smtpPassword}) : Promise.resolve(),
    ]);

    const mailboxes = parseMailboxList(input.mailboxes);
    const imap = buildEmailEndpoint({
      host: input.imapHost,
      port: input.imapPort,
      secure: input.imapSecure,
      usernameCredentialEnvKey: imapUsernameCredentialEnvKey,
      passwordCredentialEnvKey: imapPasswordCredentialEnvKey,
      label: "IMAP",
    });
    const smtp = buildEmailEndpoint({
      host: input.smtpHost,
      port: input.smtpPort,
      secure: input.smtpSecure,
      usernameCredentialEnvKey: smtpUsernameCredentialEnvKey,
      passwordCredentialEnvKey: smtpPasswordCredentialEnvKey,
      label: "SMTP",
    });

    const emailAccount = await this.email.upsertAccount({
      agentKey: normalizedAgentKey,
      accountKey,
      fromAddress,
      ...(fromName ? {fromName} : {}),
      imap,
      smtp,
      mailboxes,
      enabled: true,
    });
    const connector = await this.connectorAccounts.upsertAccount({
      source: "email",
      accountKey: emailAccount.accountKey,
      connectorKey: emailAccount.accountKey,
      ownerKind: "agent",
      ownerAgentKey: normalizedAgentKey,
      displayName: displayName ?? emailAccount.fromName ?? emailAccount.fromAddress,
      externalUsername: emailAccount.fromAddress,
      status: emailAccount.enabled ? "enabled" : "disabled",
      config: {
        fromAddress: emailAccount.fromAddress,
        ...(emailAccount.fromName ? {fromName: emailAccount.fromName} : {}),
        mailboxes: [...emailAccount.mailboxes],
        imap: emailEndpointConfigJson(emailAccount.imap),
        smtp: emailEndpointConfigJson(emailAccount.smtp),
      },
    });
    return {
      connector: publicConnector(connector),
      audit: {
        action: "upsert_email",
        agentKey: normalizedAgentKey,
        accountKey: emailAccount.accountKey,
        fromAddress: emailAccount.fromAddress,
        mailboxes: emailAccount.mailboxes,
        credentials: {
          imapUsername: imapUsername ? secretSummary(imapUsername) : null,
          imapPassword: imapPassword ? secretSummary(imapPassword) : null,
          smtpUsername: smtpUsername ? secretSummary(smtpUsername) : null,
          smtpPassword: smtpPassword ? secretSummary(smtpPassword) : null,
        },
      },
    };
  }

  async upsertTelegramConnector(session: ControlSessionRecord, agentKey: string, input: {
    accountKey?: unknown;
    botToken?: unknown;
    replace?: unknown;
  }): Promise<{connector: ControlConnectorRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    if (!this.telegramBotIdentityClient) {
      throw new Error("Telegram bot validation is not available in this Control runtime.");
    }
    if (!this.connectorCrypto) {
      throw new Error("CREDENTIALS_MASTER_KEY is required to write Telegram connector credentials.");
    }
    const accountKey = requireNonEmptyString(input.accountKey, "Telegram account key is required.");
    const botToken = requireNonEmptyString(input.botToken, "Telegram bot token is required.");
    const replace = input.replace === true;
    const existing = await this.connectorAccounts.getAccountByKey(CONTROL_TELEGRAM_SOURCE, accountKey);
    if (existing && !replace) {
      throw new Error(`Telegram account ${accountKey} already exists. Check Replace only if you are intentionally rotating that same bot; use a per-bot key such as main for Clawd and luna for Luna.`);
    }
    if (existing && existing.ownerKind === "agent" && existing.ownerAgentKey && existing.ownerAgentKey !== normalizedAgentKey) {
      throw new Error(`Telegram account ${accountKey} is already owned by agent ${existing.ownerAgentKey}. Choose a per-bot key such as ${normalizedAgentKey}, not a shared main.`);
    }
    const bot = await controlTelegramGetBotIdentitySafely(this.telegramBotIdentityClient, botToken);
    const account = await this.connectorAccounts.upsertAccount({
      source: CONTROL_TELEGRAM_SOURCE,
      accountKey,
      connectorKey: bot.id,
      ownerKind: "agent",
      ownerAgentKey: normalizedAgentKey,
      displayName: bot.displayName ?? bot.username,
      externalAccountId: bot.id,
      externalUsername: bot.username,
      status: "enabled",
    });
    await this.connectorAccounts.setSecret(account.id, CONTROL_TELEGRAM_BOT_TOKEN_SECRET_KEY, botToken, this.connectorCrypto);
    return {
      connector: publicConnector(account, (await this.connectorAccounts.listSecretKeys(account.id)).map((secret) => secret.secretKey)),
      audit: {
        action: replace ? "replace_telegram" : "upsert_telegram",
        agentKey: normalizedAgentKey,
        accountKey: account.accountKey,
        connectorKey: account.connectorKey,
        botUsername: bot.username ?? null,
        secret: secretSummary(botToken),
      },
    };
  }

  async getTelegramSetupStatus(session: ControlSessionRecord, agentKey: string, input: {accountKey?: unknown}, env: NodeJS.ProcessEnv = process.env): Promise<ControlTelegramSetupStatus> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accountKey = requireNonEmptyString(input.accountKey, "Telegram account key is required.");
    const account = await this.connectorAccounts.getAccountByKey(CONTROL_TELEGRAM_SOURCE, accountKey);
    const visibleAccount = account?.ownerKind === "agent" && account.ownerAgentKey === normalizedAgentKey ? account : null;
    const secretKeys = visibleAccount ? (await this.connectorAccounts.listSecretKeys(visibleAccount.id)).map((secret) => secret.secretKey) : [];
    let tokenValid: ControlTelegramSetupStatus["account"]["tokenValid"] = visibleAccount ? "not_checked" : "not_checked";
    let validationError: string | undefined;
    if (visibleAccount) {
      if (!secretKeys.includes(CONTROL_TELEGRAM_BOT_TOKEN_SECRET_KEY)) {
        tokenValid = "missing_secret";
      } else if (!this.connectorCrypto || !this.telegramBotIdentityClient) {
        tokenValid = "unavailable";
      } else {
        try {
          const token = await this.connectorAccounts.getSecret(visibleAccount.id, CONTROL_TELEGRAM_BOT_TOKEN_SECRET_KEY, this.connectorCrypto);
          if (!token) {
            tokenValid = "missing_secret";
          } else {
            const bot = await controlTelegramGetBotIdentitySafely(this.telegramBotIdentityClient, token);
            tokenValid = bot.id === visibleAccount.connectorKey ? "valid" : "invalid";
            if (tokenValid === "invalid") validationError = "Stored token resolves to a different bot id than this connector account.";
          }
        } catch (error) {
          tokenValid = "invalid";
          validationError = error instanceof Error ? error.message : "Telegram validation failed.";
        }
      }
    }
    const [bindings, actorPairings, agentPairings] = await Promise.all([
      this.listBindings(session, normalizedAgentKey, {source: CONTROL_TELEGRAM_SOURCE, perPage: 100}),
      this.listChannelActorPairings(session, normalizedAgentKey, {source: "telegram", connectorKey: visibleAccount?.connectorKey, perPage: 100}),
      this.listAgentPairings(session, normalizedAgentKey, {perPage: 100}),
    ]);
    const selectedBindings = visibleAccount ? bindings.data.filter((binding) => binding.connectorKey === visibleAccount.connectorKey) : [];
    const selectedActors = visibleAccount ? actorPairings.data.filter((pairing) => pairing.connectorKey === visibleAccount.connectorKey) : [];
    const traceServices = String(env.PANDA_TRACE_COLLECTOR_SERVICES ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
    const traceCollectorEnabled = env.PANDA_TRACE_COLLECTOR_ENABLED === "true" || env.PANDA_TRACE_COLLECTOR_ENABLED === "1";
    const traceServiceSelected = traceServices.includes("telegram") || traceServices.includes("panda-telegram");
    const traceSourceConfigured = typeof env.PANDA_TRACE_SOURCE_TELEGRAM === "string" && env.PANDA_TRACE_SOURCE_TELEGRAM.trim().length > 0;
    const workerEnabled = env.TELEGRAM_ENABLED === "true" || env.TELEGRAM_ENABLED === "1";
    const checklist: ControlTelegramSetupChecklistItem[] = [
      visibleAccount ? {key: "account", label: "Stored Telegram account", status: visibleAccount.status === "enabled" ? "done" : "blocked", detail: `Account ${accountKey} is ${visibleAccount.status}.`} : {key: "account", label: "Stored Telegram account", status: "blocked", detail: "Store this bot token in Control. Do not put TELEGRAM_BOT_TOKEN in .env for runtime."},
      {key: "token", label: "Bot token validates", status: tokenValid === "valid" ? "done" : tokenValid === "not_checked" ? "info" : "blocked", detail: tokenValid === "valid" ? "Telegram getMe matches the connector bot id." : validationError ?? "Token has not been validated yet."},
      {key: "session", label: "Session bound", status: selectedBindings.length > 0 ? "done" : "blocked", detail: selectedBindings.length > 0 ? `${selectedBindings.length} Telegram conversation binding(s) target a session.` : "Bind the Telegram chat/conversation id to an agent session before inbound messages can route."},
      {key: "identity", label: "Identity paired to agent", status: agentPairings.data.length > 0 ? "done" : "blocked", detail: agentPairings.data.length > 0 ? `${agentPairings.data.length} identity pairing(s) available.` : "Pair a Panda identity to this agent before pairing Telegram users."},
      {key: "actor", label: "Telegram user paired", status: selectedActors.length > 0 ? "done" : "blocked", detail: selectedActors.length > 0 ? `${selectedActors.length} numeric Telegram user id pairing(s) configured.` : "Pair the numeric Telegram user id (not @handle) to an identity paired with this agent."},
      {key: "worker", label: "Telegram worker", status: workerEnabled ? "done" : "warning", detail: workerEnabled ? "TELEGRAM_ENABLED is set. `telegram run --all-enabled` now reconciles newly enabled accounts periodically." : "Set TELEGRAM_ENABLED=true for the Docker worker, or run the smoke command manually."},
      {key: "trace", label: "Trace labels", status: !traceCollectorEnabled ? "info" : traceServiceSelected && traceSourceConfigured ? "done" : "warning", detail: !traceCollectorEnabled ? "Panda Trace collector is disabled." : traceServiceSelected && traceSourceConfigured ? "Telegram Trace source is configured." : "Add telegram to PANDA_TRACE_COLLECTOR_SERVICES and set PANDA_TRACE_SOURCE_TELEGRAM."},
    ];
    return {
      agentKey: normalizedAgentKey,
      accountKey,
      account: {
        exists: Boolean(visibleAccount),
        enabled: visibleAccount?.status === "enabled",
        ...(visibleAccount ? {status: visibleAccount.status, ownerAgentKey: visibleAccount.ownerAgentKey ?? undefined, connectorKey: visibleAccount.connectorKey, displayName: visibleAccount.displayName, externalUsername: visibleAccount.externalUsername} : {}),
        tokenStored: secretKeys.includes(CONTROL_TELEGRAM_BOT_TOKEN_SECRET_KEY),
        tokenValid,
        ...(validationError ? {validationError} : {}),
      },
      sessionBindings: {total: selectedBindings.length, bindings: selectedBindings},
      actorPairings: {total: selectedActors.length, pairings: selectedActors},
      agentPairings: {total: agentPairings.data.length, identities: agentPairings.data},
      worker: {enabled: workerEnabled, reloadRequired: false, detail: "telegram run --all-enabled hot-reconciles enabled account changes periodically; restart only if the process predates this release.", smokeCommand: `panda telegram account whoami ${accountKey}; panda telegram run --all-enabled`},
      trace: {collectorEnabled: traceCollectorEnabled, serviceSelected: traceServiceSelected, sourceEnvKey: "PANDA_TRACE_SOURCE_TELEGRAM", sourceConfigured: traceSourceConfigured, detail: traceSourceConfigured ? "Telegram Trace source id is present." : "Set PANDA_TRACE_SOURCE_TELEGRAM when Trace collector includes telegram."},
      checklist,
    };
  }

  async upsertConnector(session: ControlSessionRecord, agentKey: string, input: Record<string, unknown>): Promise<{connector: ControlConnectorRow; audit: Record<string, unknown>}> {
    const source = typeof input.source === "string" && input.source.trim() ? input.source.trim().toLowerCase() : "discord";
    if (source === "discord") return this.upsertDiscordConnector(session, agentKey, input);
    if (source === "email") return this.upsertEmailConnector(session, agentKey, input);
    if (source === "telegram") return this.upsertTelegramConnector(session, agentKey, input);
    throw new Error(`Unsupported Control connector source ${source}.`);
  }

  async setConnectorEnabled(session: ControlSessionRecord, agentKey: string, source: string, accountKey: string, enabled: boolean): Promise<{connector: ControlConnectorRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const existing = await this.connectorAccounts.getAccountByKey(source, accountKey);
    if (!existing || existing.ownerKind !== "agent" || existing.ownerAgentKey !== normalizedAgentKey) {
      throw new Error("Control connector account was not found or is not visible.");
    }
    if (existing.source === "email") {
      if (enabled) {
        const emailAccount = await this.email.getAccount(normalizedAgentKey, existing.accountKey);
        await this.email.upsertAccount({...emailAccount, enabled: true});
      } else {
        await this.email.disableAccount(normalizedAgentKey, existing.accountKey);
      }
    }
    const account = enabled
      ? await this.connectorAccounts.enableAccount(source, accountKey)
      : await this.connectorAccounts.disableAccount(source, accountKey);
    return {
      connector: publicConnector(account, (await this.connectorAccounts.listSecretKeys(account.id)).map((secret) => secret.secretKey)),
      audit: {
        action: enabled ? "enable" : "disable",
        agentKey: normalizedAgentKey,
        source,
        accountKey,
      },
    };
  }

  async listDiscordActorPairings(session: ControlSessionRecord, agentKey: string, input: ControlDiscordActorPairingTableInput = {}): Promise<ControlPaginatedResponse<ControlDiscordActorPairingRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accounts = (await this.connectorAccounts.listAccounts({source: "discord", ownerKind: "agent"}))
      .filter((account) => account.ownerAgentKey === normalizedAgentKey)
      .filter((account) => !input.accountKey || account.accountKey === input.accountKey);
    const accountByConnector = new Map(accounts.map((account) => [account.connectorKey, account]));
    if (accountByConnector.size === 0) return tableResponse([], input);

    const identities = await this.identities.listIdentities();
    const identityById = new Map(identities.map((identity) => [identity.id, identity]));
    const bindings = await Promise.all(
      identities.map((identity) => this.identities.listIdentityBindings(identity.id).catch(() => [] as readonly IdentityBindingRecord[])),
    );
    const search = normalizeSearch(input.search);
    const rows = bindings
      .flat()
      .filter((binding) => binding.source === "discord" && accountByConnector.has(binding.connectorKey))
      .map((binding) => {
        const identity = identityById.get(binding.identityId);
        const account = accountByConnector.get(binding.connectorKey);
        return identity && account ? publicDiscordActorPairing(binding, identity, account) : null;
      })
      .filter((row): row is ControlDiscordActorPairingRow => Boolean(row))
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "updatedAt") as unknown as ControlDiscordActorPairingRow[], input);
  }

  async pairDiscordActor(session: ControlSessionRecord, agentKey: string, input: {
    accountKey?: unknown;
    externalActorId?: unknown;
    actorId?: unknown;
    identityId?: unknown;
    identityHandle?: unknown;
  }): Promise<{pairing: ControlDiscordActorPairingRow; audit: Record<string, unknown>}> {
    const {agentKey: normalizedAgentKey, account} = await this.getAgentConnectorAccount(
      session,
      agentKey,
      "discord",
      requireNonEmptyString(input.accountKey, "Discord account key is required."),
      {requireEnabled: true},
    );
    const externalActorId = controlDiscordActorId(input.externalActorId ?? input.actorId);
    const identity = await this.resolveIdentity({
      identityId: input.identityId,
      identityHandle: input.identityHandle,
    });
    await this.assertIdentityPairedToAgent(normalizedAgentKey, identity.id);
    const binding = await this.identities.ensureIdentityBinding({
      source: "discord",
      connectorKey: account.connectorKey,
      externalActorId,
      identityId: identity.id,
      metadata: {
        pairedVia: "control-ui",
        accountKey: account.accountKey,
      },
    });
    return {
      pairing: publicDiscordActorPairing(binding, identity, account),
      audit: {
        action: "pair_discord_actor",
        agentKey: normalizedAgentKey,
        accountKey: account.accountKey,
        connectorKey: account.connectorKey,
        externalActorId,
        identityId: identity.id,
        identityHandle: identity.handle,
      },
    };
  }

  async deleteDiscordActorPairing(session: ControlSessionRecord, agentKey: string, accountKey: string, externalActorId: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const {agentKey: normalizedAgentKey, account} = await this.getAgentConnectorAccount(session, agentKey, "discord", accountKey);
    const normalizedActorId = controlDiscordActorId(externalActorId);
    const deleted = await this.identities.deleteIdentityBinding({
      source: "discord",
      connectorKey: account.connectorKey,
      externalActorId: normalizedActorId,
    });
    return {
      deleted,
      audit: {
        action: "delete_discord_actor_pairing",
        agentKey: normalizedAgentKey,
        accountKey: account.accountKey,
        connectorKey: account.connectorKey,
        externalActorId: normalizedActorId,
      },
    };
  }

  async listChannelActorPairings(session: ControlSessionRecord, agentKey: string, input: ControlChannelActorPairingTableInput = {}): Promise<ControlPaginatedResponse<ControlChannelActorPairingRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = input.source ? controlChannelActorPairingSource(input.source) : undefined;
    const connectorKey = typeof input.connectorKey === "string" ? trimToUndefined(input.connectorKey) : undefined;
    const pairings = await this.agents.listAgentPairings(normalizedAgentKey);
    if (pairings.length === 0) return tableResponse([], input);

    const identities = await Promise.all(pairings.map((pairing) => this.identities.getIdentity(pairing.identityId).catch(() => null)));
    const identityById = new Map(identities.filter((identity): identity is IdentityRecord => Boolean(identity)).map((identity) => [identity.id, identity]));
    const bindings = await Promise.all(
      pairings.map((pairing) => this.identities.listIdentityBindings(pairing.identityId).catch(() => [] as readonly IdentityBindingRecord[])),
    );
    const search = normalizeSearch(input.search);
    const rows = bindings
      .flat()
      .filter((binding) => isControlChannelActorPairingSource(binding.source))
      .filter((binding) => !source || binding.source === source)
      .filter((binding) => !connectorKey || binding.connectorKey === connectorKey)
      .map((binding) => {
        const identity = identityById.get(binding.identityId);
        return identity ? publicChannelActorPairing(binding, identity, normalizedAgentKey) : null;
      })
      .filter((row): row is ControlChannelActorPairingRow => Boolean(row))
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "updatedAt") as unknown as ControlChannelActorPairingRow[], input);
  }

  async pairChannelActor(session: ControlSessionRecord, agentKey: string, input: {
    source?: unknown;
    connectorKey?: unknown;
    externalActorId?: unknown;
    actorId?: unknown;
    identityId?: unknown;
    identityHandle?: unknown;
  }): Promise<{pairing: ControlChannelActorPairingRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = controlChannelActorPairingSource(input.source);
    const connectorKey = controlChannelConnectorKey(source, input.connectorKey);
    if (source === "telegram") {
      const account = await this.connectorAccounts.getAccountByConnectorKey(CONTROL_TELEGRAM_SOURCE, connectorKey);
      if (!account || account.ownerKind !== "agent" || account.ownerAgentKey !== normalizedAgentKey) {
        throw new Error("Control Telegram actor pairing requires an owned Telegram connector account. Store the bot in Control Telegram setup first.");
      }
      if (account.status !== "enabled") {
        throw new Error(`Control Telegram account ${account.accountKey} is ${account.status}; enable it before pairing actors.`);
      }
    }
    const externalActorId = controlChannelActorId(source, input.externalActorId ?? input.actorId);
    const identity = await this.resolveIdentity({
      identityId: input.identityId,
      identityHandle: input.identityHandle,
    });
    await this.assertIdentityPairedToAgent(normalizedAgentKey, identity.id);
    const binding = await this.identities.ensureIdentityBinding({
      source,
      connectorKey,
      externalActorId,
      identityId: identity.id,
      metadata: {
        pairedVia: "control-ui",
        agentKey: normalizedAgentKey,
      },
    });
    return {
      pairing: publicChannelActorPairing(binding, identity, normalizedAgentKey),
      audit: {
        action: "pair_channel_actor",
        agentKey: normalizedAgentKey,
        source,
        connectorKey,
        externalActorId,
        identityId: identity.id,
        identityHandle: identity.handle,
      },
    };
  }

  async deleteChannelActorPairing(session: ControlSessionRecord, agentKey: string, sourceInput: string, connectorKeyInput: string, externalActorIdInput: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = controlChannelActorPairingSource(sourceInput);
    const connectorKey = controlChannelConnectorKey(source, connectorKeyInput);
    const externalActorId = controlChannelActorId(source, externalActorIdInput);
    const existing = await this.identities.resolveIdentityBinding({source, connectorKey, externalActorId});
    if (existing) await this.assertIdentityPairedToAgent(normalizedAgentKey, existing.identityId);
    const deleted = await this.identities.deleteIdentityBinding({
      source,
      connectorKey,
      externalActorId,
    });
    return {
      deleted,
      audit: {
        action: "delete_channel_actor_pairing",
        agentKey: normalizedAgentKey,
        source,
        connectorKey,
        externalActorId,
      },
    };
  }

  async listBindings(session: ControlSessionRecord, agentKey: string, input: ControlBindingTableInput = {}): Promise<ControlPaginatedResponse<ControlBindingRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    if (input.sessionId) {
      await this.assertSessionVisible(session, normalizedAgentKey, input.sessionId);
    }
    const result = await this.pool.query(`
      SELECT binding.source, binding.connector_key, binding.external_conversation_id, binding.session_id,
        binding.metadata, binding.created_at, binding.updated_at,
        target_session.alias, target_session.display_name
      FROM ${this.conversationTables.conversationSessions} AS binding
      INNER JOIN ${this.connectorTables.connectorAccounts} AS account
        ON account.source = binding.source
       AND account.connector_key = binding.connector_key
       AND account.owner_kind = 'agent'
       AND account.owner_agent_key = $1
      LEFT JOIN ${this.sessionTables.sessions} AS target_session
        ON target_session.id = binding.session_id
      ORDER BY binding.updated_at DESC
    `, [normalizedAgentKey]).catch(() => ({rows: []}));
    const search = normalizeSearch(input.search);
    const rows = (result.rows as Array<Record<string, unknown>>).map((row) => {
      const metadata = typeof row.metadata === "object" && row.metadata !== null ? row.metadata as Record<string, unknown> : {};
      return {
        source: String(row.source),
        connectorKey: String(row.connector_key),
        externalConversationId: String(row.external_conversation_id),
        sessionId: String(row.session_id),
        sessionLabel: String(row.display_name ?? row.alias ?? row.session_id),
        ...(typeof metadata.displayName === "string" ? {displayName: metadata.displayName} : {}),
        createdAt: iso(row.created_at as Date)!,
        updatedAt: iso(row.updated_at as Date)!,
      };
    }).filter((row) =>
      (!input.source || row.source === input.source)
      && (!input.sessionId || row.sessionId === input.sessionId)
      && includesSearch(row, search)
    );
    return tableResponse(sortRows(rows, input, "updatedAt"), input);
  }

  async listSessionA2ABindings(session: ControlSessionRecord, agentKey: string, sessionId: string, input: ControlA2ABindingTableInput = {}): Promise<ControlPaginatedResponse<ControlA2ABindingRow>> {
    const target = await this.assertSessionVisible(session, agentKey, sessionId);
    const search = normalizeSearch(input.search);
    const visibleAgentKeys = new Set((await this.reads.listAgents(session)).map((agent) => agent.agentKey));
    const [outbound, inbound] = await Promise.all([
      input.direction === "inbound" ? Promise.resolve([] as readonly A2ASessionBindingRecord[]) : this.a2aBindings.listBindings({senderSessionId: target.id}),
      input.direction === "outbound" ? Promise.resolve([] as readonly A2ASessionBindingRecord[]) : this.a2aBindings.listBindings({recipientSessionId: target.id}),
    ]);
    const records = [...outbound, ...inbound];
    const resolved = await Promise.all(records.map(async (record) => {
      const [sender, recipient] = await Promise.all([
        this.sessions.getSession(record.senderSessionId).catch(() => null),
        this.sessions.getSession(record.recipientSessionId).catch(() => null),
      ]);
      if (!sender || !recipient) return null;
      if (!visibleAgentKeys.has(sender.agentKey) || !visibleAgentKeys.has(recipient.agentKey)) return null;
      const direction = record.senderSessionId === target.id ? "outbound" : "inbound";
      const row: ControlA2ABindingRow = {
        senderSessionId: sender.id,
        senderAgentKey: sender.agentKey,
        senderSessionLabel: sessionLabel(sender),
        recipientSessionId: recipient.id,
        recipientAgentKey: recipient.agentKey,
        recipientSessionLabel: sessionLabel(recipient),
        direction,
        createdAt: iso(record.createdAt)!,
        updatedAt: iso(record.updatedAt)!,
      };
      return row;
    }));
    const rows = resolved
      .filter((row): row is ControlA2ABindingRow => Boolean(row))
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "updatedAt") as unknown as ControlA2ABindingRow[], input);
  }

  async bindA2ASession(session: ControlSessionRecord, agentKey: string, sessionId: string, input: {
    recipientSessionId?: unknown;
    oneWay?: unknown;
  }): Promise<{bindings: ControlA2ABindingRow[]; audit: Record<string, unknown>}> {
    const sender = await this.assertSessionVisible(session, agentKey, sessionId);
    const recipientSessionId = requireNonEmptyString(input.recipientSessionId, "Recipient session is required.");
    const recipient = await this.assertAnyVisibleSession(session, recipientSessionId);
    if (sender.id === recipient.id) {
      throw new Error("A2A bindings require two different sessions.");
    }

    const oneWay = input.oneWay === true;
    await this.a2aBindings.bindSession({
      senderSessionId: sender.id,
      recipientSessionId: recipient.id,
    });
    if (!oneWay) {
      await this.a2aBindings.bindSession({
        senderSessionId: recipient.id,
        recipientSessionId: sender.id,
      });
    }

    const bindings = await this.listSessionA2ABindings(session, sender.agentKey, sender.id, {perPage: 100});
    return {
      bindings: bindings.data,
      audit: {
        action: "bind_a2a_session",
        agentKey: sender.agentKey,
        targetSessionId: sender.id,
        recipientAgentKey: recipient.agentKey,
        recipientSessionId: recipient.id,
        oneWay,
      },
    };
  }

  async deleteA2ABinding(session: ControlSessionRecord, agentKey: string, sessionId: string, peerSessionIdInput: string, input: {
    direction?: unknown;
    oneWay?: unknown;
  } = {}): Promise<{deleted: boolean; reverseDeleted: boolean; audit: Record<string, unknown>}> {
    const current = await this.assertSessionVisible(session, agentKey, sessionId);
    const peer = await this.assertAnyVisibleSession(session, peerSessionIdInput);
    const oneWay = input.oneWay === true;
    const direction = input.direction === "inbound" ? "inbound" : "outbound";
    const sender = direction === "inbound" ? peer : current;
    const recipient = direction === "inbound" ? current : peer;
    const deleted = await this.a2aBindings.deleteBinding({
      senderSessionId: sender.id,
      recipientSessionId: recipient.id,
    });
    const reverseDeleted = oneWay ? false : await this.a2aBindings.deleteBinding({
      senderSessionId: recipient.id,
      recipientSessionId: sender.id,
    });
    return {
      deleted,
      reverseDeleted,
      audit: {
        action: "delete_a2a_session_binding",
        agentKey: current.agentKey,
        targetSessionId: current.id,
        peerAgentKey: peer.agentKey,
        peerSessionId: peer.id,
        direction,
        oneWay,
      },
    };
  }

  async bindConversation(session: ControlSessionRecord, agentKey: string, input: {
    source?: unknown;
    connectorKey?: unknown;
    externalConversationId?: unknown;
    sessionId?: unknown;
    displayName?: unknown;
  }): Promise<{binding: ControlBindingRow; previousSessionId?: string; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const sessionId = requireNonEmptyString(input.sessionId, "Binding session id is required.");
    const target = await this.assertSessionVisible(session, normalizedAgentKey, sessionId);
    const source = requireNonEmptyString(input.source, "Binding source is required.");
    const connectorKey = requireNonEmptyString(input.connectorKey, "Binding connector key is required.");
    const externalConversationId = requireNonEmptyString(input.externalConversationId, "External conversation id is required.");
    const account = await this.connectorAccounts.getAccountByConnectorKey(source, connectorKey);
    if (!account || account.ownerKind !== "agent" || account.ownerAgentKey !== normalizedAgentKey) {
      throw new Error("Control connector account was not found or is not visible.");
    }
    const displayName = typeof input.displayName === "string" ? trimToUndefined(input.displayName) : undefined;
    const result = await this.conversations.bindConversation({
      source,
      connectorKey,
      externalConversationId,
      sessionId: target.id,
      ...(displayName ? {metadata: {displayName}} : {}),
    });
    return {
      binding: {
        source: result.binding.source,
        connectorKey: result.binding.connectorKey,
        externalConversationId: result.binding.externalConversationId,
        sessionId: result.binding.sessionId,
        sessionLabel: sessionLabel(target),
        ...(displayName ? {displayName} : {}),
        createdAt: iso(result.binding.createdAt)!,
        updatedAt: iso(result.binding.updatedAt)!,
      },
      ...(result.previousSessionId ? {previousSessionId: result.previousSessionId} : {}),
      audit: {
        action: "bind",
        agentKey: normalizedAgentKey,
        source,
        connectorKey,
        externalConversationId,
        targetSessionId: target.id,
        previousSessionId: result.previousSessionId ?? null,
      },
    };
  }

  async deleteBinding(session: ControlSessionRecord, agentKey: string, source: string, connectorKey: string, externalConversationId: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const account = await this.connectorAccounts.getAccountByConnectorKey(source, connectorKey);
    if (!account || account.ownerKind !== "agent" || account.ownerAgentKey !== normalizedAgentKey) {
      throw new Error("Control connector account was not found or is not visible.");
    }
    const deleted = await this.conversations.deleteConversationBinding({source, connectorKey, externalConversationId});
    return {
      deleted,
      audit: {
        action: "delete",
        agentKey: normalizedAgentKey,
        source,
        connectorKey,
        externalConversationId,
      },
    };
  }

  async listEmailRoutes(session: ControlSessionRecord, agentKey: string, input: ControlEmailRouteTableInput = {}): Promise<ControlPaginatedResponse<ControlEmailRouteRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const routes = await this.email.listRoutes(normalizedAgentKey, input.accountKey);
    const search = normalizeSearch(input.search);
    const rows = await Promise.all(routes.map(async (route) => {
      const target = await this.sessions.getSession(route.sessionId).catch(() => undefined);
      return publicEmailRoute(route, target);
    }));
    const filtered = rows.filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(filtered as unknown as Record<string, unknown>[], input, "updatedAt") as unknown as ControlEmailRouteRow[], input);
  }

  async setEmailRoute(session: ControlSessionRecord, agentKey: string, input: {
    accountKey?: unknown;
    mailbox?: unknown;
    sessionId?: unknown;
  }): Promise<{route: ControlEmailRouteRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accountKey = requireNonEmptyString(input.accountKey, "Email route account key is required.");
    const existing = await existingEmailAccount(this.email, normalizedAgentKey, accountKey);
    if (!existing) throw new Error("Control email account was not found or is not visible.");
    const target = await this.assertSessionVisible(
      session,
      normalizedAgentKey,
      requireNonEmptyString(input.sessionId, "Email route session id is required."),
    );
    const mailbox = typeof input.mailbox === "string" ? trimToUndefined(input.mailbox) : undefined;
    const route = await this.email.setRoute({
      agentKey: normalizedAgentKey,
      accountKey,
      ...(mailbox ? {mailbox} : {}),
      sessionId: target.id,
    });
    return {
      route: publicEmailRoute(route, target),
      audit: {
        action: "set_email_route",
        agentKey: normalizedAgentKey,
        accountKey,
        mailbox: mailbox ?? null,
        targetSessionId: target.id,
      },
    };
  }

  async deleteEmailRoute(session: ControlSessionRecord, agentKey: string, accountKey: string, mailbox?: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const existing = await existingEmailAccount(this.email, normalizedAgentKey, accountKey);
    if (!existing) throw new Error("Control email account was not found or is not visible.");
    const normalizedMailbox = trimToUndefined(mailbox ?? "");
    const deleted = await this.email.removeRoute({
      agentKey: normalizedAgentKey,
      accountKey,
      ...(normalizedMailbox ? {mailbox: normalizedMailbox} : {}),
    });
    return {
      deleted,
      audit: {
        action: "delete_email_route",
        agentKey: normalizedAgentKey,
        accountKey,
        mailbox: normalizedMailbox ?? null,
      },
    };
  }

  async listEmailAllowedRecipients(session: ControlSessionRecord, agentKey: string, input: ControlEmailAllowedRecipientTableInput = {}): Promise<ControlPaginatedResponse<ControlEmailAllowedRecipientRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accounts = (await this.connectorAccounts.listAccounts({source: "email", ownerKind: "agent"}))
      .filter((account) => account.ownerAgentKey === normalizedAgentKey)
      .filter((account) => !input.accountKey || account.accountKey === input.accountKey);
    const recipients = await Promise.all(accounts.map((account) => this.email.listAllowedRecipients(normalizedAgentKey, account.accountKey)));
    const search = normalizeSearch(input.search);
    const rows = recipients
      .flat()
      .map((recipient) => publicEmailAllowedRecipient(recipient))
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "createdAt") as unknown as ControlEmailAllowedRecipientRow[], input);
  }

  async addEmailAllowedRecipient(session: ControlSessionRecord, agentKey: string, input: {
    accountKey?: unknown;
    address?: unknown;
  }): Promise<{recipient: ControlEmailAllowedRecipientRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const accountKey = requireNonEmptyString(input.accountKey, "Email allowlist account key is required.");
    const existing = await existingEmailAccount(this.email, normalizedAgentKey, accountKey);
    if (!existing) throw new Error("Control email account was not found or is not visible.");
    const address = requireNonEmptyString(input.address, "Email allowlist recipient address is required.");
    const recipient = await this.email.addAllowedRecipient(normalizedAgentKey, accountKey, address);
    return {
      recipient: publicEmailAllowedRecipient(recipient),
      audit: {
        action: "add_email_allowed_recipient",
        agentKey: normalizedAgentKey,
        accountKey,
        address: recipient.address,
      },
    };
  }

  async deleteEmailAllowedRecipient(session: ControlSessionRecord, agentKey: string, accountKey: string, address: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedAccountKey = requireNonEmptyString(accountKey, "Email allowlist account key is required.");
    const existing = await existingEmailAccount(this.email, normalizedAgentKey, normalizedAccountKey);
    if (!existing) throw new Error("Control email account was not found or is not visible.");
    const normalizedAddress = requireNonEmptyString(address, "Email allowlist recipient address is required.");
    const deleted = await this.email.removeAllowedRecipient(normalizedAgentKey, normalizedAccountKey, normalizedAddress);
    return {
      deleted,
      audit: {
        action: "delete_email_allowed_recipient",
        agentKey: normalizedAgentKey,
        accountKey: normalizedAccountKey,
        address: normalizedAddress,
      },
    };
  }

  async listSkills(session: ControlSessionRecord, agentKey: string, input: ControlSkillTableInput = {}): Promise<ControlPaginatedResponse<ControlSkillRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const search = normalizeSearch(input.search);
    const tag = input.tag ? normalizeAgentSkillTag(input.tag) : undefined;
    const rows = (await this.agents.listAgentSkills(normalizedAgentKey))
      .map((skill) => publicSkill(skill))
      .filter((row) => {
        if (tag && !row.tags.includes(tag)) return false;
        return includesSearch(row as unknown as Record<string, unknown>, search);
      });
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "skillKey") as unknown as ControlSkillRow[], input);
  }

  async getSkill(session: ControlSessionRecord, agentKey: string, skillKey: string): Promise<ControlSkillRow> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const skill = await this.agents.readAgentSkill(normalizedAgentKey, skillKey);
    if (!skill) throw new Error("Control skill was not found.");
    return publicSkill(skill, true);
  }

  async setSkill(session: ControlSessionRecord, agentKey: string, input: {
    skillKey?: unknown;
    description?: unknown;
    content?: unknown;
    tags?: unknown;
  }): Promise<{skill: ControlSkillRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const skillKey = requireNonEmptyString(input.skillKey, "Skill key is required.");
    const description = requireNonEmptyString(input.description, "Skill description is required.");
    const content = requireNonEmptyString(input.content, "Skill content is required.");
    const tags = parseControlSkillTags(input.tags);
    const skill = await this.agents.setAgentSkill(normalizedAgentKey, skillKey, description, content, tags);
    return {
      skill: publicSkill(skill, true),
      audit: {
        action: "set",
        agentKey: normalizedAgentKey,
        skillKey: skill.skillKey,
        content: secretSummary(content),
        tags: skill.tags,
      },
    };
  }

  async deleteSkill(session: ControlSessionRecord, agentKey: string, skillKey: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const deleted = await this.agents.deleteAgentSkill(normalizedAgentKey, skillKey);
    return {
      deleted,
      audit: {
        action: "delete",
        agentKey: normalizedAgentKey,
        skillKey,
      },
    };
  }

  async listSubagents(session: ControlSessionRecord, agentKey: string, input: ControlSubagentTableInput = {}): Promise<ControlPaginatedResponse<ControlSubagentRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const search = normalizeSearch(input.search);
    const rows = (await this.subagents.listProfiles({agentKey: normalizedAgentKey, includeDisabled: true}))
      .map((profile) => publicSubagent(profile))
      .filter((row) => {
        if (input.enabled !== undefined && row.enabled !== input.enabled) return false;
        if (input.source && row.source !== input.source) return false;
        if (input.toolGroups?.length && !input.toolGroups.some((toolGroup) => row.toolGroups.includes(toolGroup))) return false;
        return includesSearch(row as unknown as Record<string, unknown>, search);
      });
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "slug") as unknown as ControlSubagentRow[], input);
  }

  async getSubagent(session: ControlSessionRecord, agentKey: string, slug: string): Promise<ControlSubagentRow> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const profile = await this.subagents.getProfile({agentKey: normalizedAgentKey, slug, includeDisabled: true});
    if (!profile) throw new Error("Control subagent profile was not found.");
    return publicSubagent(profile, true);
  }

  async setSubagent(session: ControlSessionRecord, agentKey: string, input: {
    slug?: unknown;
    description?: unknown;
    prompt?: unknown;
    toolGroups?: unknown;
    model?: unknown;
    thinking?: unknown;
    enabled?: unknown;
  }): Promise<{subagent: ControlSubagentRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const slug = requireNonEmptyString(input.slug, "Subagent slug is required.");
    const description = requireNonEmptyString(input.description, "Subagent description is required.");
    const prompt = requireNonEmptyString(input.prompt, "Subagent prompt is required.");
    const toolGroups = Array.isArray(input.toolGroups) ? input.toolGroups.map((value) => String(value)) : ["core"];
    const profile = await this.subagents.upsertProfile({
      slug,
      agentKey: normalizedAgentKey,
      description,
      prompt,
      toolGroups,
      model: typeof input.model === "string" ? input.model : null,
      thinking: typeof input.thinking === "string" ? input.thinking as never : null,
      source: "custom",
      createdByAgentKey: normalizedAgentKey,
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    });
    return {
      subagent: publicSubagent(profile, true),
      audit: {
        action: "set",
        agentKey: normalizedAgentKey,
        slug: profile.slug,
        prompt: secretSummary(prompt),
      },
    };
  }

  async setSubagentEnabled(session: ControlSessionRecord, agentKey: string, slug: string, enabled: boolean): Promise<{subagent: ControlSubagentRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const profile = await this.subagents.setProfileEnabled({agentKey: normalizedAgentKey, slug, enabled});
    return {
      subagent: publicSubagent(profile, true),
      audit: {
        action: enabled ? "enable" : "disable",
        agentKey: normalizedAgentKey,
        slug: profile.slug,
      },
    };
  }

  async listGatewaySources(session: ControlSessionRecord, agentKey: string, input: ControlTableInput = {}): Promise<ControlPaginatedResponse<ControlGatewaySourceRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const search = normalizeSearch(input.search);
    const rows = (await this.gateway.listSources()).filter((source) => source.agentKey === normalizedAgentKey).map(publicGatewaySource).filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "sourceId") as unknown as ControlGatewaySourceRow[], input);
  }

  async createGatewaySource(session: ControlSessionRecord, agentKey: string, input: {
    sourceId?: unknown;
    name?: unknown;
    sessionId?: unknown;
  }): Promise<{result: ControlGatewaySourceSecretResult; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
      ? (await this.assertSessionVisible(session, normalizedAgentKey, input.sessionId)).id
      : undefined;
    const result = await this.gateway.createSource({
      sourceId: requireNonEmptyString(input.sourceId, "Gateway source id is required."),
      name: typeof input.name === "string" ? trimToUndefined(input.name) : undefined,
      agentKey: normalizedAgentKey,
      identityId: session.identityId,
      ...(sessionId ? {sessionId} : {}),
    });
    return {
      result: {
        source: publicGatewaySource(result.source),
        clientSecret: result.clientSecret,
      },
      audit: {
        action: "create",
        agentKey: normalizedAgentKey,
        sourceId: result.source.sourceId,
        sessionId: sessionId ?? null,
      },
    };
  }

  async rotateGatewaySource(session: ControlSessionRecord, agentKey: string, sourceId: string): Promise<{result: ControlGatewaySourceSecretResult; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const current = await this.gateway.getSource(sourceId);
    if (current.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const result = await this.gateway.rotateSourceSecret(sourceId);
    return {
      result: {source: publicGatewaySource(result.source), clientSecret: result.clientSecret},
      audit: {action: "rotate_secret", agentKey: normalizedAgentKey, sourceId},
    };
  }

  async setGatewaySourceSuspended(session: ControlSessionRecord, agentKey: string, sourceId: string, suspended: boolean, reason?: string): Promise<{source: ControlGatewaySourceRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const current = await this.gateway.getSource(sourceId);
    if (current.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const next = suspended ? await this.gateway.suspendSource(sourceId, reason ?? "control-ui") : (await this.gateway.resumeSource(sourceId)).source;
    return {
      source: publicGatewaySource(next),
      audit: {action: suspended ? "suspend" : "resume", agentKey: normalizedAgentKey, sourceId},
    };
  }

  async listGatewayDevices(session: ControlSessionRecord, agentKey: string, sourceId: string, input: ControlGatewayDeviceTableInput = {}): Promise<ControlPaginatedResponse<ControlGatewayDeviceRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = await this.gateway.getSource(sourceId);
    if (source.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const search = normalizeSearch(input.search);
    const capabilities = input.capabilities?.filter((capability) => capability.trim() !== "") ?? [];
    const rows = (await this.gateway.listDevices({sourceId}))
      .map(publicGatewayDevice)
      .filter((row) => {
        if (input.enabled !== undefined && row.enabled !== input.enabled) return false;
        if (capabilities.length > 0 && !capabilities.every((capability) => row.capabilities.includes(capability as GatewayDeviceCapability))) return false;
        return includesSearch({
          sourceId: row.sourceId,
          deviceId: row.deviceId,
          label: row.label,
          capabilities: row.capabilities,
          enabled: row.enabled ? "enabled" : "disabled",
          lastSeenAt: row.lastSeenAt,
        }, search);
      });
    return tableResponse(sortRows(rows, input, "deviceId"), input);
  }

  async registerGatewayDevice(session: ControlSessionRecord, agentKey: string, sourceId: string, input: {
    deviceId?: unknown;
    label?: unknown;
    capabilities?: unknown;
  }): Promise<{device: ControlGatewayDeviceRow; token: string; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = await this.gateway.getSource(sourceId);
    if (source.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const token = generateOpaqueToken(GATEWAY_DEVICE_TOKEN_PREFIX, GATEWAY_DEVICE_TOKEN_BYTES);
    const capabilities = Array.isArray(input.capabilities) ? input.capabilities.map((value) => String(value) as GatewayDeviceCapability) : [];
    const device = await this.gateway.registerDevice({
      sourceId,
      deviceId: requireNonEmptyString(input.deviceId, "Gateway device id is required."),
      tokenHash: hashOpaqueToken(token),
      label: typeof input.label === "string" ? trimToUndefined(input.label) : undefined,
      capabilities,
    });
    return {
      device: publicGatewayDevice(device),
      token,
      audit: {
        action: "register_device",
        agentKey: normalizedAgentKey,
        sourceId,
        deviceId: device.deviceId,
        token: secretSummary(token),
      },
    };
  }

  async setGatewayDeviceEnabled(session: ControlSessionRecord, agentKey: string, sourceId: string, deviceId: string, enabled: boolean): Promise<{device: ControlGatewayDeviceRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = await this.gateway.getSource(sourceId);
    if (source.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const device = await this.gateway.setDeviceEnabled({sourceId, deviceId, enabled});
    return {
      device: publicGatewayDevice(device),
      audit: {action: enabled ? "enable_device" : "disable_device", agentKey: normalizedAgentKey, sourceId, deviceId},
    };
  }

  async getWikiBinding(session: ControlSessionRecord, agentKey: string): Promise<ControlWikiBindingRow | null> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const binding = await this.wikiBindings.store.getBinding(normalizedAgentKey);
    return binding ? publicWikiBinding(binding) : null;
  }

  async setWikiBinding(session: ControlSessionRecord, agentKey: string, input: {
    wikiGroupId?: unknown;
    namespacePath?: unknown;
    apiToken?: unknown;
  }): Promise<{binding: ControlWikiBindingRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    if (!this.wikiBindings.service) {
      throw new Error("CREDENTIALS_MASTER_KEY is required to write wiki bindings.");
    }

    const wikiGroupId = normalizeWikiGroupId(Number(input.wikiGroupId));
    const namespacePath = normalizeWikiNamespacePath(requireNonEmptyString(input.namespacePath, "Wiki namespace path is required."));
    const apiToken = requireNonEmptyString(input.apiToken, "Wiki API token is required.");
    const binding = await this.wikiBindings.service.setBinding({
      agentKey: normalizedAgentKey,
      wikiGroupId,
      namespacePath,
      apiToken,
    });
    return {
      binding: {
        agentKey: binding.agentKey,
        wikiGroupId: binding.wikiGroupId,
        namespacePath: binding.namespacePath,
        createdAt: iso(binding.createdAt)!,
        updatedAt: iso(binding.updatedAt)!,
      },
      audit: {
        action: "set_wiki_binding",
        agentKey: normalizedAgentKey,
        wikiGroupId: binding.wikiGroupId,
        namespacePath: binding.namespacePath,
        secret: secretSummary(apiToken),
      },
    };
  }

  async clearWikiBinding(session: ControlSessionRecord, agentKey: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const binding = await this.wikiBindings.store.getBinding(normalizedAgentKey);
    const deleted = await this.wikiBindings.store.deleteBinding(normalizedAgentKey);
    return {
      deleted,
      audit: {
        action: "clear_wiki_binding",
        agentKey: normalizedAgentKey,
        ...(binding ? {
          wikiGroupId: binding.wikiGroupId,
          namespacePath: binding.namespacePath,
        } : {}),
      },
    };
  }

  async listGatewayEventTypes(session: ControlSessionRecord, agentKey: string, sourceId: string, input: ControlTableInput = {}): Promise<ControlPaginatedResponse<ControlGatewayEventTypeRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = await this.gateway.getSource(sourceId);
    if (source.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const search = normalizeSearch(input.search);
    const rows = (await this.gateway.listEventTypes(sourceId))
      .map(publicGatewayEventType)
      .filter((eventType) => includesSearch(eventType as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows, input, "type"), input);
  }

  async upsertGatewayEventType(session: ControlSessionRecord, agentKey: string, sourceId: string, input: {
    type?: unknown;
    delivery?: unknown;
  }): Promise<{eventType: ControlGatewayEventTypeRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = await this.gateway.getSource(sourceId);
    if (source.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const delivery = input.delivery === "wake" ? "wake" : "queue";
    const eventType = await this.gateway.upsertEventType({sourceId, type: requireNonEmptyString(input.type, "Gateway event type is required."), delivery});
    return {
      eventType: publicGatewayEventType(eventType),
      audit: {action: "allow_type", agentKey: normalizedAgentKey, sourceId, type: eventType.type, delivery: eventType.delivery},
    };
  }

  async deleteGatewayEventType(session: ControlSessionRecord, agentKey: string, sourceId: string, type: string): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const source = await this.gateway.getSource(sourceId);
    if (source.agentKey !== normalizedAgentKey) throw new Error("Control gateway source was not found or is not visible.");
    const normalizedType = normalizeGatewayEventType(type);
    const deleted = await this.gateway.deleteEventType(source.sourceId, normalizedType);
    return {
      deleted,
      audit: {action: "disallow_type", agentKey: normalizedAgentKey, sourceId: source.sourceId, type: normalizedType, existed: deleted, deleted},
    };
  }

  async listGatewayEvents(session: ControlSessionRecord, agentKey: string, input: ControlTableInput & {sourceId?: string; sessionId?: string} = {}): Promise<ControlPaginatedResponse<ControlGatewayEventRow>> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    if (input.sessionId) await this.assertSessionVisible(session, normalizedAgentKey, input.sessionId);
    const sources = (await this.gateway.listSources()).filter((source) => source.agentKey === normalizedAgentKey);
    const sourceIds = new Set(sources.filter((source) => !input.sessionId || source.sessionId === input.sessionId).map((source) => source.sourceId));
    const events = input.sourceId
      ? sourceIds.has(input.sourceId) ? await this.gateway.listEvents({sourceId: input.sourceId, limit: 200}) : []
      : (await Promise.all([...sourceIds].map((sourceId) => this.gateway.listEvents({sourceId, limit: 100})))).flat();
    const search = normalizeSearch(input.search);
    const rows = events.map(publicGatewayEvent).filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "createdAt") as unknown as ControlGatewayEventRow[], input);
  }

  async listAuditEvents(session: ControlSessionRecord, input: ControlTableInput & {eventType?: string; agentKey?: string; targetSessionId?: string} = {}): Promise<ControlPaginatedResponse<ControlAuditEventSummary>> {
    const agentKey = input.agentKey ? await this.assertAgentVisible(session, input.agentKey) : undefined;
    if (agentKey && input.targetSessionId) await this.assertSessionVisible(session, agentKey, input.targetSessionId);
    const search = normalizeSearch(input.search);
    const rows = (await this.reads.listAuditEvents(session, {limit: 100, eventType: input.eventType, agentKey, targetSessionId: input.targetSessionId}))
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(rows as unknown as Record<string, unknown>[], input, "createdAt") as unknown as ControlAuditEventSummary[], input);
  }

  async listWorkFailures(session: ControlSessionRecord, input: ControlWorkFailureTableInput = {}): Promise<ControlPaginatedResponse<ControlWorkFailureRow>> {
    const agents = await this.reads.listAgents(session);
    const visibleAgentKeys = agents.map((agent) => agent.agentKey);
    if (visibleAgentKeys.length === 0) return tableResponse([], input);
    const rows: ControlWorkFailureRow[] = [];
    rows.push(...await this.runtimeRunFailures(visibleAgentKeys));
    rows.push(...await this.scheduledRunFailures(visibleAgentKeys));
    rows.push(...await this.outboundFailures(visibleAgentKeys));
    rows.push(...await this.gatewayFailures(visibleAgentKeys));
    rows.push(...await this.connectorFailures(visibleAgentKeys));
    const search = normalizeSearch(input.search);
    const filtered = rows
      .filter((row) => !input.severity || row.severity === input.severity)
      .filter((row) => !input.kind || row.kind === input.kind)
      .filter((row) => includesSearch(row as unknown as Record<string, unknown>, search));
    return tableResponse(sortRows(filtered as unknown as Record<string, unknown>[], {...input, sortBy: input.sortBy ?? "createdAt", sortDirection: input.sortDirection ?? "desc"}, "createdAt") as unknown as ControlWorkFailureRow[], input);
  }

  private async runtimeRunFailures(agentKeys: readonly string[]): Promise<ControlWorkFailureRow[]> {
    const result = await this.pool.query(`
      SELECT run.id, run.error, run.started_at, run.finished_at, target_thread.session_id,
        target_session.agent_key, target_session.alias, target_session.display_name
      FROM ${this.threadTables.runs} AS run
      INNER JOIN ${this.threadTables.threads} AS target_thread ON target_thread.id = run.thread_id
      INNER JOIN ${this.sessionTables.sessions} AS target_session ON target_session.id = target_thread.session_id
      WHERE run.status = 'failed'
        AND target_session.agent_key = ANY($1::text[])
      ORDER BY COALESCE(run.finished_at, run.started_at) DESC
      LIMIT 50
    `, [agentKeys]).catch(() => ({rows: []}));
    return (result.rows as Array<Record<string, unknown>>).map((row) => {
      const agentKey = String(row.agent_key);
      const sessionId = String(row.session_id);
      return {
        id: `runtime:${String(row.id)}`,
        kind: "runtime_run",
        severity: "critical",
        agentKey,
        sessionId,
        sessionLabel: String(row.display_name ?? row.alias ?? sessionId),
        source: "Runtime",
        summary: "Agent run failed.",
        detail: row.error ? "Run failed; inspect the session runtime tab for the sanitized category." : undefined,
        targetRoute: `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}?tab=runtime`,
        createdAt: iso(row.finished_at as Date | undefined) ?? iso(row.started_at as Date | undefined) ?? new Date().toISOString(),
      };
    });
  }

  private async scheduledRunFailures(agentKeys: readonly string[]): Promise<ControlWorkFailureRow[]> {
    const result = await this.pool.query(`
      SELECT run.id, run.error, run.created_at, run.session_id, target_session.agent_key,
        target_session.alias, target_session.display_name, task.title
      FROM ${this.scheduledTables.scheduledTaskRuns} AS run
      INNER JOIN ${this.sessionTables.sessions} AS target_session ON target_session.id = run.session_id
      LEFT JOIN ${this.scheduledTables.scheduledTasks} AS task ON task.id = run.task_id
      WHERE run.status = 'failed'
        AND target_session.agent_key = ANY($1::text[])
      ORDER BY run.created_at DESC
      LIMIT 50
    `, [agentKeys]).catch(() => ({rows: []}));
    return (result.rows as Array<Record<string, unknown>>).map((row) => {
      const agentKey = String(row.agent_key);
      const sessionId = String(row.session_id);
      return {
        id: `scheduled:${String(row.id)}`,
        kind: "scheduled_task_run",
        severity: "warning",
        agentKey,
        sessionId,
        sessionLabel: String(row.display_name ?? row.alias ?? sessionId),
        source: "Scheduled task",
        summary: `Scheduled task failed${typeof row.title === "string" ? `: ${row.title}` : "."}`,
        detail: row.error ? "Scheduled task run failed; inspect the automations tab for sanitized run details." : undefined,
        targetRoute: `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}?tab=automations`,
        createdAt: iso(row.created_at as Date)!,
      };
    });
  }

  private async outboundFailures(agentKeys: readonly string[]): Promise<ControlWorkFailureRow[]> {
    if (!await tableExists(this.pool, this.deliveryTables.outboundDeliveries)) return [];
    const result = await this.pool.query(`
      SELECT delivery.id, delivery.channel, delivery.connector_key, delivery.external_conversation_id,
        delivery.last_error, delivery.created_at, target_thread.session_id, target_session.agent_key,
        target_session.alias, target_session.display_name
      FROM ${this.deliveryTables.outboundDeliveries} AS delivery
      LEFT JOIN ${this.threadTables.threads} AS target_thread ON target_thread.id = delivery.thread_id
      LEFT JOIN ${this.sessionTables.sessions} AS target_session ON target_session.id = target_thread.session_id
      WHERE delivery.status = 'failed'
        AND target_session.agent_key = ANY($1::text[])
      ORDER BY delivery.created_at DESC
      LIMIT 50
    `, [agentKeys]).catch(() => ({rows: []}));
    return (result.rows as Array<Record<string, unknown>>).map((row) => {
      const agentKey = String(row.agent_key);
      const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
      return {
        id: `outbound:${String(row.id)}`,
        kind: "outbound_delivery",
        severity: "warning",
        agentKey,
        ...(sessionId ? {sessionId, sessionLabel: String(row.display_name ?? row.alias ?? sessionId)} : {}),
        source: `${String(row.channel)}/${String(row.connector_key)}`,
        summary: "Outbound delivery failed.",
        detail: row.last_error ? "Outbound delivery failed; inspect the channel worker logs for details." : undefined,
        targetRoute: sessionId ? `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}?tab=runtime` : `/agents/${encodeURIComponent(agentKey)}`,
        createdAt: iso(row.created_at as Date)!,
      };
    });
  }

  private async gatewayFailures(agentKeys: readonly string[]): Promise<ControlWorkFailureRow[]> {
    if (!await tableExists(this.pool, this.gatewayTables.events)) return [];
    const [events, commands] = await Promise.all([
      this.pool.query(`
        SELECT event.id, event.source_id, event.event_type, event.reason, event.created_at,
          source.agent_key, source.session_id, target_session.alias, target_session.display_name
        FROM ${this.gatewayTables.events} AS event
        INNER JOIN ${this.gatewayTables.sources} AS source ON source.source_id = event.source_id
        LEFT JOIN ${this.sessionTables.sessions} AS target_session ON target_session.id = source.session_id
        WHERE event.status = 'quarantined'
          AND source.agent_key = ANY($1::text[])
        ORDER BY event.created_at DESC
        LIMIT 50
      `, [agentKeys]).catch(() => ({rows: []})),
      this.pool.query(`
        SELECT command.id, command.source_id, command.device_id, command.kind, command.error, command.created_at,
          source.agent_key, source.session_id, target_session.alias, target_session.display_name
        FROM ${this.gatewayTables.commands} AS command
        INNER JOIN ${this.gatewayTables.sources} AS source ON source.source_id = command.source_id
        LEFT JOIN ${this.sessionTables.sessions} AS target_session ON target_session.id = source.session_id
        WHERE command.status IN ('failed', 'timed_out', 'rejected')
          AND source.agent_key = ANY($1::text[])
        ORDER BY command.created_at DESC
        LIMIT 50
      `, [agentKeys]).catch(() => ({rows: []})),
    ]);
    return [
      ...(events.rows as Array<Record<string, unknown>>).map((row) => {
        const agentKey = String(row.agent_key);
        const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
        return {
          id: `gateway-event:${String(row.id)}`,
          kind: "gateway_event" as const,
          severity: "warning" as const,
          agentKey,
          ...(sessionId ? {sessionId, sessionLabel: String(row.display_name ?? row.alias ?? sessionId)} : {}),
          source: `Gateway ${String(row.source_id)}`,
          summary: `Gateway event quarantined: ${String(row.event_type)}.`,
          detail: typeof row.reason === "string" ? row.reason.slice(0, 120) : undefined,
          targetRoute: sessionId ? `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionId)}?tab=gateway` : `/agents/${encodeURIComponent(agentKey)}?tab=gateway`,
          createdAt: iso(row.created_at as Date)!,
        };
      }),
      ...(commands.rows as Array<Record<string, unknown>>).map((row) => {
        const agentKey = String(row.agent_key);
        const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
        return {
          id: `gateway-command:${String(row.id)}`,
          kind: "gateway_device_command" as const,
          severity: "warning" as const,
          agentKey,
          ...(sessionId ? {sessionId, sessionLabel: String(row.display_name ?? row.alias ?? sessionId)} : {}),
          source: `Gateway ${String(row.source_id)}/${String(row.device_id)}`,
          summary: `Gateway device command failed: ${String(row.kind)}.`,
          detail: row.error ? "Gateway command failed; inspect gateway device logs for details." : undefined,
          targetRoute: `/agents/${encodeURIComponent(agentKey)}?tab=gateway`,
          createdAt: iso(row.created_at as Date)!,
        };
      }),
    ];
  }

  private async connectorFailures(agentKeys: readonly string[]): Promise<ControlWorkFailureRow[]> {
    const result = await this.pool.query(`
      SELECT id, source, account_key, connector_key, display_name, owner_agent_key, updated_at
      FROM ${this.connectorTables.connectorAccounts}
      WHERE status = 'error'
        AND owner_kind = 'agent'
        AND owner_agent_key = ANY($1::text[])
      ORDER BY updated_at DESC
      LIMIT 50
    `, [agentKeys]).catch(() => ({rows: []}));
    return (result.rows as Array<Record<string, unknown>>).map((row) => {
      const agentKey = String(row.owner_agent_key);
      return {
        id: `connector:${String(row.id)}`,
        kind: "connector_account",
        severity: "warning",
        agentKey,
        source: `${String(row.source)}/${String(row.connector_key)}`,
        summary: `Connector account is in error: ${String(row.display_name ?? row.account_key)}.`,
        targetRoute: `/agents/${encodeURIComponent(agentKey)}?tab=connectors`,
        createdAt: iso(row.updated_at as Date)!,
      };
    });
  }
}
