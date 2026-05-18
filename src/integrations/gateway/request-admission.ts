import type {IncomingMessage} from "node:http";

import {GatewayHttpError} from "./http-body.js";
import {
  isGatewayClientAllowed,
  resolveGatewayClientAddress,
  type GatewayNetworkControls,
} from "./network-controls.js";

interface GatewayRequestAdmissionStore {
  useRateLimit(input: {
    key: string;
    limit: number;
    windowMs: number;
  }): Promise<{allowed: boolean}>;
}

/**
 * Applies the public gateway admission policy shared by health, token, and
 * event routes: trusted-proxy address resolution, IP allowlist, and IP rate
 * limit. Route handlers should only run after this succeeds.
 */
export async function admitGatewayHttpRequest(input: {
  network: GatewayNetworkControls;
  rateLimitPerMinute: number;
  request: IncomingMessage;
  store: GatewayRequestAdmissionStore;
}): Promise<void> {
  const clientAddress = resolveGatewayClientAddress({
    remoteAddress: input.request.socket.remoteAddress,
    forwardedFor: input.request.headers["x-forwarded-for"],
    trustedProxies: input.network.trustedProxies,
  });
  if (!isGatewayClientAllowed(clientAddress, input.network.allowlist)) {
    throw new GatewayHttpError(403, "Forbidden.");
  }
  const requestBudget = await input.store.useRateLimit({
    key: `gateway:ip:${clientAddress}:requests`,
    windowMs: 60_000,
    limit: input.rateLimitPerMinute,
  });
  if (!requestBudget.allowed) {
    throw new GatewayHttpError(429, "Rate limit exceeded.");
  }
}
