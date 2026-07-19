import {AgentAppRequestError} from "./http-errors.js";
import {stripHttpPathPrefix} from "../../lib/http-path-prefix.js";

function readRawRequestPathname(requestTarget: string): string {
  const withoutFragment = requestTarget.split("#", 1)[0] ?? "";
  if (withoutFragment.startsWith("/")) {
    return withoutFragment.split("?", 1)[0] || "/";
  }

  const absoluteForm = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/.exec(withoutFragment);
  if (absoluteForm) {
    return absoluteForm[1] || "/";
  }

  return withoutFragment.split("?", 1)[0] || "/";
}

function assertNoRawPathDotSegments(requestTarget: string): void {
  for (const segment of readRawRequestPathname(requestTarget).split("/")) {
    if (!segment) {
      continue;
    }

    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new AgentAppRequestError(400, "Malformed request path.");
    }

    if (decodedSegment.includes("/") || decodedSegment.includes("\\")) {
      throw new AgentAppRequestError(400, "Encoded path separators are not allowed.");
    }

    if (decodedSegment === "." || decodedSegment === "..") {
      throw new AgentAppRequestError(400, "Path dot segments are not allowed.");
    }
  }
}

function splitPathname(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new AgentAppRequestError(400, "Malformed request path.");
  }
}

function isKnownAgentAppPath(pathname: string, parts: readonly string[]): boolean {
  return pathname === "/health"
    || pathname === "/panda-app-sdk.js"
    || (parts[0] === "apps" && parts[1] === "open")
    || Boolean(parseAgentAppUiPath(parts))
    || (parts[0] === "api" && parts[1] === "apps" && parts.length >= 5);
}

export function parseAgentAppRequestTarget(requestTarget: string, options: {pathPrefix?: string} = {}): {
  parts: string[];
  requestUrl: URL;
} {
  assertNoRawPathDotSegments(requestTarget);
  const requestUrl = new URL(requestTarget, "http://apps.local");
  const strippedPathname = stripHttpPathPrefix(requestUrl.pathname, options.pathPrefix ?? "");
  const strippedParts = splitPathname(strippedPathname);
  if (strippedPathname !== requestUrl.pathname && isKnownAgentAppPath(strippedPathname, strippedParts)) {
    requestUrl.pathname = strippedPathname;
    return {
      parts: strippedParts,
      requestUrl,
    };
  }

  return {
    parts: splitPathname(requestUrl.pathname),
    requestUrl,
  };
}

export function parseAgentAppUiPath(parts: readonly string[]): {
  agentKey: string;
  appSlug: string;
  relativeAssetPath: string;
} | null {
  if (parts.length < 3 || parts[0] === "api" || parts[1] !== "apps") {
    return null;
  }

  return {
    agentKey: parts[0] ?? "",
    appSlug: parts[2] ?? "",
    relativeAssetPath: parts.slice(3).join("/"),
  };
}
