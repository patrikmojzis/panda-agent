import {trimToUndefined} from "../../lib/strings.js";
import type {BrowserPreviewOriginGrant} from "./protocol.js";

/** Resolves explicit and env-configured private hostnames that browser navigation may reach. */
export function readAllowedPrivateHostnames(
  env: NodeJS.ProcessEnv,
  explicit: readonly string[] | undefined,
): readonly string[] {
  if (explicit?.length) {
    return explicit;
  }

  const raw = trimToUndefined(env.BROWSER_ALLOW_PRIVATE_HOSTS);
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => trimToUndefined(value))
    .filter((value): value is string => Boolean(value));
}

export function browserNetworkProtocols(): readonly string[] {
  return ["http:", "https:", "ws:", "wss:"];
}

export function browserNavigationProtocols(): readonly string[] {
  return ["http:", "https:"];
}

export function isBrowserNetworkProtocol(protocol: string): boolean {
  return browserNetworkProtocols().includes(protocol.toLowerCase());
}

export function isWebSocketProtocol(protocol: string): boolean {
  return ["ws:", "wss:"].includes(protocol.toLowerCase());
}

function websocketOriginForHttpOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Builds the temporary private origins allowed for a trusted worker preview grant. */
export function buildPreviewPrivateOrigins(grant: BrowserPreviewOriginGrant | undefined): string[] {
  if (!grant) {
    return [];
  }

  const websocketOrigin = websocketOriginForHttpOrigin(grant.resolvedOrigin);
  return [
    grant.resolvedOrigin,
    ...(websocketOrigin ? [websocketOrigin] : []),
  ];
}

export function isMainFrameNavigationRequest(request: {
  isNavigationRequest?: () => boolean;
  resourceType?: () => string;
  frame?: () => {parentFrame?: () => unknown};
}): boolean {
  if (request.isNavigationRequest?.() !== true || request.resourceType?.() !== "document") {
    return false;
  }
  try {
    return request.frame?.().parentFrame?.() === null;
  } catch {
    return false;
  }
}
