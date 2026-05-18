import {AgentAppRequestError} from "./http-errors.js";

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

export function parseAgentAppRequestTarget(requestTarget: string): {
  parts: string[];
  requestUrl: URL;
} {
  assertNoRawPathDotSegments(requestTarget);
  const requestUrl = new URL(requestTarget, "http://apps.local");

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
