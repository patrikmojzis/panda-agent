import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {AgentStore} from "../../domain/agents/store.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {SessionRouteRepo} from "../../domain/sessions/routes/repo.js";
import type {SessionRouteRecord} from "../../domain/sessions/routes/types.js";
import {
  renderPairedIdentitiesContext,
  type PairedIdentityChannelHint,
  type PairedIdentityEntry,
  type PairedIdentityRouteHint,
} from "../../prompts/contexts/paired-identities.js";

const DEFAULT_MAX_IDENTITIES = 25;

export type PairedIdentitiesAgentStore = Pick<AgentStore, "listAgentPairings">;
export type PairedIdentitiesIdentityStore = Pick<IdentityStore, "getIdentity" | "listIdentityBindings">;
export type PairedIdentitiesRouteStore = Pick<SessionRouteRepo, "listLatestIdentityRoutes">;

export interface PairedIdentitiesContextOptions {
  agentKey: string;
  sessionId: string;
  agentStore: PairedIdentitiesAgentStore;
  identityStore: PairedIdentitiesIdentityStore;
  routes?: PairedIdentitiesRouteStore;
  maxIdentities?: number;
}

function routeHintFromRecord(record: SessionRouteRecord): PairedIdentityRouteHint {
  return {
    source: record.route.source,
    connectorKey: record.route.connectorKey,
    externalConversationId: record.route.externalConversationId,
    ...(record.route.externalActorId ? {externalActorId: record.route.externalActorId} : {}),
  };
}

function bindingMatchesRoute(binding: PairedIdentityChannelHint, route: PairedIdentityRouteHint | undefined): boolean {
  return Boolean(
    route
    && binding.source === route.source
    && binding.connectorKey === route.connectorKey
    && route.externalActorId === binding.externalActorId,
  );
}

function resolveMaxIdentities(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_IDENTITIES;
}

export class PairedIdentitiesContext extends LlmContext {
  override name = "Paired Identities";

  private readonly options: PairedIdentitiesContextOptions;

  constructor(options: PairedIdentitiesContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const maxIdentities = resolveMaxIdentities(this.options.maxIdentities);
    const pairings = (await this.options.agentStore.listAgentPairings(this.options.agentKey))
      .slice(0, maxIdentities);
    if (pairings.length === 0) {
      return "";
    }

    const identityIds = pairings.map((pairing) => pairing.identityId);
    const routeRecords = this.options.routes
      ? await this.options.routes.listLatestIdentityRoutes({
        sessionId: this.options.sessionId,
        identityIds,
      })
      : [];
    const routeByIdentityId = new Map(routeRecords.flatMap((record) => (
      record.identityId ? [[record.identityId, routeHintFromRecord(record)] as const] : []
    )));

    const entries = await Promise.all(pairings.map(async (pairing): Promise<PairedIdentityEntry | null> => {
      const identity = await this.options.identityStore.getIdentity(pairing.identityId)
        .catch(() => null);
      if (!identity || identity.status !== "active") {
        return null;
      }

      const recentRoute = routeByIdentityId.get(identity.id);
      const channelHints = (await this.options.identityStore.listIdentityBindings(identity.id).catch(() => []))
        .map((binding): PairedIdentityChannelHint => ({
          source: binding.source,
          connectorKey: binding.connectorKey,
          externalActorId: binding.externalActorId,
        }))
        .filter((hint) => !bindingMatchesRoute(hint, recentRoute));

      return {
        handle: identity.handle,
        displayName: identity.displayName,
        ...(recentRoute ? {recentRoute} : {}),
        channelHints,
      };
    }));

    return renderPairedIdentitiesContext(
      entries
        .filter((entry): entry is PairedIdentityEntry => Boolean(entry))
        .sort((left, right) => left.handle.localeCompare(right.handle)),
    );
  }
}
