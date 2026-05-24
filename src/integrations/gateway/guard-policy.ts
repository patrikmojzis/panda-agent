import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../../domain/gateway/types.js";
import type {JsonObject} from "../../lib/json.js";
import type {GatewayGuard} from "./guard.js";

export const DEFAULT_GATEWAY_GUARD_THRESHOLD = 0.85;
export const DEFAULT_GATEWAY_GUARD_TIMEOUT_MS = 120_000;

const STRIKE_WINDOW_MS = 10 * 60_000;
const STRIKE_THRESHOLD = 3;

interface GatewayGuardPolicyStore {
  markEventQuarantined(input: {
    claimId?: string;
    eventId: string;
    metadata: JsonObject;
    reason: string;
    riskScore: number;
    attachmentQuarantineTtlMs?: number;
  }): Promise<unknown>;
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

export async function evaluateGatewayGuardPolicy(input: {
  attachmentQuarantineTtlMs?: number;
  attachments?: readonly GatewayEventAttachmentRecord[];
  event: GatewayEventRecord;
  guard: GatewayGuard;
  guardThreshold?: number;
  guardTimeoutMs?: number;
  source: GatewaySourceRecord;
  store: GatewayGuardPolicyStore;
}): Promise<{deliver: true; riskScore: number} | {deliver: false}> {
  let riskScore: number;
  try {
    const verdict = await scoreWithTimeout(
      input.guard,
      {event: input.event, source: input.source, attachments: input.attachments},
      input.guardTimeoutMs ?? DEFAULT_GATEWAY_GUARD_TIMEOUT_MS,
    );
    riskScore = verdict.riskScore;
  } catch (error) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      claimId: input.event.claimId,
      riskScore: 1,
      reason: error instanceof Error ? `guard failed: ${error.message}` : "guard failed",
      metadata: {gateway: {guardFailed: true}},
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
    return {deliver: false};
  }

  const threshold = input.guardThreshold ?? DEFAULT_GATEWAY_GUARD_THRESHOLD;
  if (riskScore >= threshold) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      claimId: input.event.claimId,
      riskScore,
      reason: "guard risk threshold exceeded",
      metadata: {gateway: {guardThreshold: threshold}},
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
    await input.store.recordStrikeAndMaybeSuspend({
      sourceId: input.event.sourceId,
      kind: "guard_high_risk",
      reason: `guard risk score ${riskScore.toFixed(3)}`,
      eventId: input.event.id,
      threshold: STRIKE_THRESHOLD,
      windowMs: STRIKE_WINDOW_MS,
      metadata: {riskScore},
    });
    return {deliver: false};
  }

  return {
    deliver: true,
    riskScore,
  };
}
