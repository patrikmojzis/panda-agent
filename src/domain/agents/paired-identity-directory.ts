import type {PgQueryable} from "../../lib/postgres-query.js";
import {toJson} from "../../lib/postgres-values.js";
import {optionalTrimmedString, requireNonEmptyString} from "../../lib/strings.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {normalizeIdentityHandle} from "../identity/types.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildSessionRouteTableNames} from "../sessions/routes/postgres-shared.js";
import {buildAgentTableNames} from "./postgres-shared.js";

const MAX_IDENTITY_LIMIT = 100;
const MAX_BINDING_LIMIT = 20;

export interface PairedIdentityDirectoryBinding {
  source: string;
  connectorKey: string;
  externalActorId: string;
}

export interface PairedIdentityDirectoryRoute {
  source: string;
  connectorKey: string;
  externalConversationId: string;
  externalActorId?: string;
}

export interface PairedIdentityDirectoryEntry {
  identityId: string;
  handle: string;
  displayName: string;
  recentRoute?: PairedIdentityDirectoryRoute;
  bindings: readonly PairedIdentityDirectoryBinding[];
  /** Bindings beyond the returned, route-deduplicated binding window. */
  additionalBindingCount: number;
}

export interface ListPairedIdentityDirectoryInput {
  sessionId: string;
  identityLimit: number;
  bindingLimit: number;
}

export interface PostgresPairedIdentityDirectoryOptions {
  pool: PgQueryable;
}

export interface PairedIdentityDirectoryReader {
  listForSession(
    input: ListPairedIdentityDirectoryInput,
  ): Promise<readonly PairedIdentityDirectoryEntry[]>;
}

interface IdentityRow {
  identity_id: unknown;
  handle: unknown;
  display_name: unknown;
}

interface BindingRow {
  identity_id: unknown;
  source: unknown;
  connector_key: unknown;
  external_actor_id: unknown;
  binding_count: unknown;
}

interface RouteRow {
  identity_id: unknown;
  channel: unknown;
  connector_key: unknown;
  external_conversation_id: unknown;
  external_actor_id: unknown;
}

function requireBoundedLimit(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function requireOpaqueString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function requirePersistedString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string") {
    throw new Error(errorMessage);
  }
  return value;
}

function requirePositiveCount(value: unknown, errorMessage: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[0-9]+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function parseIdentityRow(row: IdentityRow): Omit<PairedIdentityDirectoryEntry, "bindings" | "recentRoute" | "additionalBindingCount"> {
  return {
    identityId: requireNonEmptyString(row.identity_id, "Paired identity row is missing identity id."),
    handle: normalizeIdentityHandle(
      requireNonEmptyString(row.handle, "Paired identity row is missing handle."),
    ),
    displayName: requirePersistedString(row.display_name, "Paired identity row is missing display name."),
  };
}

function parseBindingRow(row: BindingRow): {
  identityId: string;
  binding: PairedIdentityDirectoryBinding;
  bindingCount: number;
} {
  return {
    identityId: requireNonEmptyString(row.identity_id, "Paired identity binding row is missing identity id."),
    binding: {
      source: requireNonEmptyString(row.source, "Paired identity binding row is missing source."),
      connectorKey: requireNonEmptyString(
        row.connector_key,
        "Paired identity binding row is missing connector key.",
      ),
      externalActorId: requireOpaqueString(
        row.external_actor_id,
        "Paired identity binding row is missing external actor id.",
      ),
    },
    bindingCount: requirePositiveCount(
      row.binding_count,
      "Paired identity binding row has an invalid binding count.",
    ),
  };
}

function parseRouteRow(row: RouteRow): {identityId: string; route: PairedIdentityDirectoryRoute} {
  const externalActorId = optionalTrimmedString(
    row.external_actor_id,
    "Paired identity route external actor id must be a string.",
  );
  return {
    identityId: requireNonEmptyString(row.identity_id, "Paired identity route row is missing identity id."),
    route: {
      source: requireNonEmptyString(row.channel, "Paired identity route row is missing source."),
      connectorKey: requireNonEmptyString(
        row.connector_key,
        "Paired identity route row is missing connector key.",
      ),
      externalConversationId: requireNonEmptyString(
        row.external_conversation_id,
        "Paired identity route row is missing conversation id.",
      ),
      ...(externalActorId ? {externalActorId} : {}),
    },
  };
}

/**
 * Reads a bounded, session-scoped view of identities paired to the session's
 * agent. The three-query budget is independent of identity and binding count.
 */
export class PostgresPairedIdentityDirectory implements PairedIdentityDirectoryReader {
  private readonly pool: PgQueryable;
  private readonly agents = buildAgentTableNames();
  private readonly identities = buildIdentityTableNames();
  private readonly sessions = buildSessionTableNames();
  private readonly routes = buildSessionRouteTableNames();

  constructor(options: PostgresPairedIdentityDirectoryOptions) {
    this.pool = options.pool;
  }

  async listForSession(input: ListPairedIdentityDirectoryInput): Promise<readonly PairedIdentityDirectoryEntry[]> {
    const sessionId = requireNonEmptyString(input.sessionId, "Paired identity session id must not be empty.");
    const identityLimit = requireBoundedLimit(input.identityLimit, "Paired identity limit", MAX_IDENTITY_LIMIT);
    const bindingLimit = requireBoundedLimit(input.bindingLimit, "Paired identity binding limit", MAX_BINDING_LIMIT);

    const identityResult = await this.pool.query(`
      SELECT
        identity.id AS identity_id,
        identity.handle,
        identity.display_name
      FROM ${this.sessions.sessions} session
      INNER JOIN ${this.agents.agentPairings} pairing
        ON pairing.agent_key = session.agent_key
      INNER JOIN ${this.identities.identities} identity
        ON identity.id = pairing.identity_id
      WHERE session.id = $1
        AND identity.status = 'active'
      ORDER BY pairing.created_at ASC, pairing.identity_id ASC
      LIMIT $2
    `, [sessionId, identityLimit]);
    const identities = identityResult.rows.map((row) => parseIdentityRow(row as IdentityRow));
    if (identities.length === 0) {
      return [];
    }

    const identityIds = identities.map((identity) => identity.identityId);
    const routeResult = await this.pool.query(`
      SELECT DISTINCT ON (route.identity_id)
        route.identity_id,
        route.channel,
        route.connector_key,
        route.external_conversation_id,
        route.external_actor_id
      FROM ${this.routes.sessionRoutes} route
      WHERE route.session_id = $1
        AND route.identity_id = ANY($2::text[])
      ORDER BY
        route.identity_id ASC,
        route.captured_at_ms DESC,
        route.updated_at DESC,
        route.id DESC
    `, [sessionId, identityIds]);
    const routeByIdentity = new Map<string, PairedIdentityDirectoryRoute>();
    for (const row of routeResult.rows) {
      const parsed = parseRouteRow(row as RouteRow);
      routeByIdentity.set(parsed.identityId, parsed.route);
    }

    const routeBindingExclusions = [...routeByIdentity]
      .flatMap(([identityId, route]) => route.externalActorId
        ? [{
            identityId,
            source: route.source,
            connectorKey: route.connectorKey,
            externalActorId: route.externalActorId,
          }]
        : []);

    // Routes are intentionally read first so the matching binding is removed
    // before ranking and counting; otherwise the prompt's omitted count lies.
    const bindingResult = await this.pool.query(`
      WITH route_binding_exclusions AS (
        SELECT
          exclusion->>'identityId' AS identity_id,
          exclusion->>'source' AS source,
          exclusion->>'connectorKey' AS connector_key,
          exclusion->>'externalActorId' AS external_actor_id
        FROM jsonb_array_elements($2::jsonb) exclusion
      ),
      ranked_bindings AS (
        SELECT
          binding.identity_id,
          binding.source,
          binding.connector_key,
          binding.external_actor_id,
          COUNT(*) OVER (PARTITION BY binding.identity_id) AS binding_count,
          ROW_NUMBER() OVER (
            PARTITION BY binding.identity_id
            ORDER BY binding.created_at ASC, binding.id ASC
          ) AS binding_rank
        FROM ${this.identities.identityBindings} binding
        LEFT JOIN route_binding_exclusions exclusion
          ON exclusion.identity_id = binding.identity_id
          AND exclusion.source = binding.source
          AND exclusion.connector_key = binding.connector_key
          AND exclusion.external_actor_id = binding.external_actor_id
        WHERE binding.identity_id = ANY($1::text[])
          AND exclusion.identity_id IS NULL
      )
      SELECT
        identity_id,
        source,
        connector_key,
        external_actor_id,
        binding_count
      FROM ranked_bindings
      WHERE binding_rank <= $3
      ORDER BY identity_id ASC, binding_rank ASC
    `, [identityIds, toJson(routeBindingExclusions), bindingLimit]);

    const bindingsByIdentity = new Map<string, PairedIdentityDirectoryBinding[]>();
    const bindingCountByIdentity = new Map<string, number>();
    for (const row of bindingResult.rows) {
      const parsed = parseBindingRow(row as BindingRow);
      const bindings = bindingsByIdentity.get(parsed.identityId) ?? [];
      bindings.push(parsed.binding);
      bindingsByIdentity.set(parsed.identityId, bindings);
      bindingCountByIdentity.set(parsed.identityId, parsed.bindingCount);
    }

    return identities.map((identity) => {
      const recentRoute = routeByIdentity.get(identity.identityId);
      const bindings = bindingsByIdentity.get(identity.identityId) ?? [];
      const bindingCount = bindingCountByIdentity.get(identity.identityId) ?? 0;
      return {
        ...identity,
        ...(recentRoute ? {recentRoute} : {}),
        bindings,
        additionalBindingCount: Math.max(0, bindingCount - bindings.length),
      };
    });
  }
}
