import type {ServerResponse} from "node:http";

import ipaddr from "ipaddr.js";

import {truncateText} from "./strings.js";

/**
 * Serializes `payload` as JSON and writes it with the provided status code.
 */
export function writeJsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {"content-type": "application/json"});
  response.end(JSON.stringify(payload));
}

/**
 * Appends `endpoint` onto a base URL, clearing any existing search/hash
 * fragments so callers always hit the intended JSON route.
 */
export function buildEndpointUrl(baseUrl: string, endpoint: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${endpoint}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Reads an HTTP error body, trims surrounding whitespace, and truncates it to a
 * caller-provided character budget.
 */
export async function readResponseError(response: Response, maxChars: number): Promise<string> {
  const text = (await response.text()).trim();
  return truncateText(text, maxChars);
}

/**
 * Normalizes hostnames from URL/bind-address inputs for security comparisons.
 */
export function normalizeHttpHostname(hostname: string): string {
  const normalized = hostname.trim().replace(/\.+$/, "").toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

/**
 * Returns true for localhost names and IP addresses in the loopback range.
 */
export function isLoopbackHttpHostname(hostname: string): boolean {
  const normalized = normalizeHttpHostname(hostname);
  if (normalized === "localhost") {
    return true;
  }

  try {
    return ipaddr.process(normalized).range() === "loopback";
  } catch {
    return false;
  }
}
