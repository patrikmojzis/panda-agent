import type {ServerResponse} from "node:http";

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
