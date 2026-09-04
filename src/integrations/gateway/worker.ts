import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../../domain/gateway/types.js";
import {DrainLoop} from "../../lib/drain-loop.js";
import type {JsonObject} from "../../lib/json.js";
import {deliverGatewayEventToThread, readGatewayDeliveryAssessment, type GatewayDeliveryStore} from "./delivery.js";
import type {GatewayGuard} from "./guard.js";
import {
  DEFAULT_GATEWAY_GUARD_THRESHOLD,
  DEFAULT_GATEWAY_GUARD_TIMEOUT_MS,
  evaluateGatewayGuardPolicy,
} from "./guard-policy.js";

const DEFAULT_WORKER_POLL_MS = 1_000;
const DEFAULT_WORKER_BATCH_SIZE = 10;
const DEFAULT_WORKER_CONCURRENCY = 4;

export {DEFAULT_GATEWAY_GUARD_THRESHOLD, DEFAULT_GATEWAY_GUARD_TIMEOUT_MS};

interface GatewayWorkerStore extends GatewayDeliveryStore {
  claimPendingEvents(limit: number): Promise<readonly GatewayEventRecord[]>;
  getEvent(eventId: string): Promise<GatewayEventRecord>;
  getSource(sourceId: string): Promise<GatewaySourceRecord>;
  listEventAttachments(eventId: string): Promise<readonly GatewayEventAttachmentRecord[]>;
  recordStrikeAndMaybeSuspend(input: {
    eventId?: string;
    kind: "guard_high_risk";
    metadata: JsonObject;
    reason: string;
    sourceId: string;
    threshold: number;
    windowMs: number;
  }): Promise<unknown>;
}

export interface GatewayWorkerOptions {
  attachmentQuarantineTtlMs?: number;
  attachmentRetentionMs?: number;
  guard: GatewayGuard;
  guardThreshold?: number;
  guardTimeoutMs?: number;
  pollMs?: number;
  store: GatewayWorkerStore;
  workerConcurrency?: number;
}

export interface GatewayWorker {
  poke(): void;
  close(): Promise<void>;
}

async function quarantineSuspendedSource(
  options: GatewayWorkerOptions,
  event: GatewayEventRecord,
  source: GatewaySourceRecord,
): Promise<void> {
  await options.store.markEventQuarantined({
    eventId: event.id,
    claimId: event.claimId,
    ...(event.trusted ? {} : {riskScore: 1}),
    reason: `source ${source.sourceId} is suspended`,
    metadata: {gateway: {sourceSuspended: true}},
    attachmentQuarantineTtlMs: options.attachmentQuarantineTtlMs,
  });
}

async function processGatewayEvent(options: GatewayWorkerOptions, event: GatewayEventRecord): Promise<void> {
  if (event.status !== "pending" && event.status !== "processing") {
    return;
  }

  const source = await options.store.getSource(event.sourceId);
  if (source.status !== "active") {
    await quarantineSuspendedSource(options, event, source);
    return;
  }

  const attachments = await options.store.listEventAttachments(event.id);
  let assessment = readGatewayDeliveryAssessment(event);
  if (!assessment) {
    if (event.trusted) {
      assessment = {guardStatus: "bypassed" as const, trusted: true as const};
    } else {
      const guardResult = await evaluateGatewayGuardPolicy({
        attachments,
        attachmentQuarantineTtlMs: options.attachmentQuarantineTtlMs,
        event,
        guard: options.guard,
        guardThreshold: options.guardThreshold,
        guardTimeoutMs: options.guardTimeoutMs,
        source,
        store: options.store,
      });
      if (!guardResult.deliver) {
        return;
      }
      assessment = {
        guardStatus: "scored" as const,
        riskScore: guardResult.riskScore,
        trusted: false as const,
      };
    }
  }

  await deliverGatewayEventToThread({
    event,
    assessment,
    attachmentQuarantineTtlMs: options.attachmentQuarantineTtlMs,
    attachmentRetentionMs: options.attachmentRetentionMs,
    attachments,
    source,
    store: options.store,
  });
}

function groupEventsBySource(events: readonly GatewayEventRecord[]): GatewayEventRecord[][] {
  const groups = new Map<string, GatewayEventRecord[]>();
  for (const event of events) {
    const group = groups.get(event.sourceId);
    if (group) {
      group.push(event);
    } else {
      groups.set(event.sourceId, [event]);
    }
  }
  return [...groups.values()];
}

async function processClaimedGatewayEvent(
  options: GatewayWorkerOptions,
  event: GatewayEventRecord,
): Promise<void> {
  try {
    await processGatewayEvent(options, event);
  } catch (error) {
    // Only explicit guard/authority decisions quarantine payloads. An unknown
    // persistence failure must not scrub evidence or contradict a committed input.
    console.error("Gateway event processing failed; retaining its durable state", {
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function processSourceGroups(
  options: GatewayWorkerOptions,
  groups: readonly GatewayEventRecord[][],
): Promise<void> {
  let nextIndex = 0;
  const concurrency = Math.max(
    1,
    Math.min(groups.length, Math.floor(options.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY)),
  );
  await Promise.all(Array.from({length: concurrency}, async () => {
    while (nextIndex < groups.length) {
      const group = groups[nextIndex];
      nextIndex += 1;
      if (!group) {
        continue;
      }
      for (const event of group) {
        await processClaimedGatewayEvent(options, event);
      }
    }
  }));
}

export function startGatewayWorker(options: GatewayWorkerOptions): GatewayWorker {
  const drainLoop = new DrainLoop({
    label: "Gateway worker drain",
    pollIntervalMs: options.pollMs ?? DEFAULT_WORKER_POLL_MS,
    drain: async () => {
      const events = await options.store.claimPendingEvents(DEFAULT_WORKER_BATCH_SIZE);
      await processSourceGroups(options, groupEventsBySource(events));
    },
    onError: (error) => {
      console.error("Gateway worker drain failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  drainLoop.start();

  return {
    poke(): void {
      drainLoop.kick();
    },
    async close(): Promise<void> {
      await drainLoop.stop();
    },
  };
}
