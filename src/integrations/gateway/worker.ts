import type {JsonObject} from "../../kernel/agent/types.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {GatewayEventRecord, GatewaySourceRecord, PostgresGatewayStore} from "../../domain/gateway/index.js";
import type {PostgresSessionStore} from "../../domain/sessions/index.js";
import type {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/index.js";
import {renderGatewayInboundText} from "../../prompts/channels/gateway.js";
import type {GatewayGuard} from "./guard.js";

export const DEFAULT_GATEWAY_GUARD_THRESHOLD = 0.85;
export const DEFAULT_GATEWAY_GUARD_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_POLL_MS = 1_000;
const DEFAULT_WORKER_BATCH_SIZE = 10;
const DEFAULT_WORKER_CONCURRENCY = 4;
const STRIKE_WINDOW_MS = 10 * 60_000;
const STRIKE_THRESHOLD = 3;

export interface GatewayWorkerOptions {
  guard: GatewayGuard;
  guardThreshold?: number;
  guardTimeoutMs?: number;
  pollMs?: number;
  store: PostgresGatewayStore;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  workerConcurrency?: number;
}

async function shouldLeaveDeliveryStateAlone(
  options: GatewayWorkerOptions,
  event: GatewayEventRecord,
): Promise<boolean> {
  const current = await options.store.getEvent(event.id);
  return current.status === "delivering" || current.status === "delivered";
}

export interface GatewayWorker {
  poke(): void;
  close(): Promise<void>;
}

function buildGatewayMetadata(input: {
  event: GatewayEventRecord;
  riskScore: number;
}): JsonObject {
  return {
    gateway: {
      sourceId: input.event.sourceId,
      eventId: input.event.id,
      eventType: input.event.type,
      deliveryRequested: input.event.deliveryRequested,
      deliveryEffective: input.event.deliveryEffective,
      occurredAt: input.event.occurredAt ? new Date(input.event.occurredAt).toISOString() : null,
      receivedAt: new Date(input.event.createdAt).toISOString(),
      riskScore: input.riskScore,
      textBytes: input.event.textBytes,
      textSha256: input.event.textSha256,
      metadataTrust: "external_untrusted",
    },
  };
}

async function quarantineSuspendedSource(
  options: GatewayWorkerOptions,
  event: GatewayEventRecord,
  source: GatewaySourceRecord,
): Promise<void> {
  await options.store.markEventQuarantined({
    eventId: event.id,
    claimId: event.claimId,
    riskScore: 1,
    reason: `source ${source.sourceId} is suspended`,
    metadata: {gateway: {sourceSuspended: true}},
  });
}

async function resolveTargetThreadId(
  options: GatewayWorkerOptions,
  source: GatewaySourceRecord,
): Promise<string> {
  if (source.sessionId) {
    const session = await options.sessionStore.getSession(source.sessionId);
    return session.currentThreadId;
  }

  const mainSession = await options.sessionStore.getMainSession(source.agentKey);
  if (!mainSession) {
    throw new Error(`Agent ${source.agentKey} does not have a main session.`);
  }
  return mainSession.currentThreadId;
}

async function scoreWithTimeout(
  guard: GatewayGuard,
  input: Parameters<GatewayGuard["score"]>[0],
  timeoutMs: number,
): Promise<{riskScore: number}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await Promise.race([
      guard.score({...input, signal: controller.signal}),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`guard timed out after ${String(timeoutMs)}ms`));
        }, {once: true});
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  let riskScore: number;
  try {
    const verdict = await scoreWithTimeout(
      options.guard,
      {event, source},
      options.guardTimeoutMs ?? DEFAULT_GATEWAY_GUARD_TIMEOUT_MS,
    );
    riskScore = verdict.riskScore;
  } catch (error) {
    await options.store.markEventQuarantined({
      eventId: event.id,
      claimId: event.claimId,
      riskScore: 1,
      reason: error instanceof Error ? `guard failed: ${error.message}` : "guard failed",
      metadata: {gateway: {guardFailed: true}},
    });
    return;
  }

  if (riskScore >= (options.guardThreshold ?? DEFAULT_GATEWAY_GUARD_THRESHOLD)) {
    await options.store.markEventQuarantined({
      eventId: event.id,
      claimId: event.claimId,
      riskScore,
      reason: "guard risk threshold exceeded",
      metadata: {gateway: {guardThreshold: options.guardThreshold ?? DEFAULT_GATEWAY_GUARD_THRESHOLD}},
    });
    await options.store.recordStrikeAndMaybeSuspend({
      sourceId: event.sourceId,
      kind: "guard_high_risk",
      reason: `guard risk score ${riskScore.toFixed(3)}`,
      eventId: event.id,
      threshold: STRIKE_THRESHOLD,
      windowMs: STRIKE_WINDOW_MS,
      metadata: {riskScore},
    });
    return;
  }

  const threadId = await resolveTargetThreadId(options, source);
  const metadata = buildGatewayMetadata({event, riskScore});
  if (!event.claimId) {
    await options.store.markEventQuarantined({
      eventId: event.id,
      riskScore: 1,
      reason: "gateway event is missing a processing claim",
      metadata: {gateway: {missingClaim: true}},
    });
    return;
  }
  const reserved = await options.store.reserveEventDelivery({
    eventId: event.id,
    claimId: event.claimId,
    riskScore,
    metadata,
  });
  if (!reserved) {
    return;
  }
  await options.threadStore.enqueueInput(threadId, {
    source: "gateway",
    channelId: event.sourceId,
    externalMessageId: event.id,
    actorId: event.sourceId,
    identityId: source.identityId,
    message: stringToUserMessage(renderGatewayInboundText({
      sourceId: event.sourceId,
      eventId: event.id,
      eventType: event.type,
      delivery: event.deliveryEffective,
      occurredAt: event.occurredAt ? new Date(event.occurredAt).toISOString() : undefined,
      receivedAt: new Date(event.createdAt).toISOString(),
      riskScore,
      text: event.text,
    })),
    metadata,
  }, event.deliveryEffective);
  await options.store.markEventDelivered({
    eventId: event.id,
    claimId: event.claimId,
    threadId,
    riskScore,
    metadata,
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
    if (await shouldLeaveDeliveryStateAlone(options, event).catch(() => false)) {
      return;
    }
    await options.store.markEventQuarantined({
      eventId: event.id,
      claimId: event.claimId,
      riskScore: 1,
      reason: error instanceof Error ? error.message : "gateway worker failed",
      metadata: {gateway: {workerFailed: true}},
    }).catch(() => undefined);
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
  let closed = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number): void => {
    if (closed || timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    timer.unref();
  };

  const run = async (): Promise<void> => {
    if (closed || running) {
      return;
    }
    running = (async () => {
      const events = await options.store.claimPendingEvents(DEFAULT_WORKER_BATCH_SIZE);
      await processSourceGroups(options, groupEventsBySource(events));
    })().finally(() => {
      running = null;
      schedule(options.pollMs ?? DEFAULT_WORKER_POLL_MS);
    });
    await running;
  };

  schedule(0);

  return {
    poke(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void run();
    },
    async close(): Promise<void> {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await running;
    },
  };
}
