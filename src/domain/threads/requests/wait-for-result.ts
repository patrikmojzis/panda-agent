import {sleep} from "../../../lib/async.js";
import type {RuntimeRequestRepo} from "./repo.js";

/** Waits for a persisted result without cancelling the request when the caller times out. */
export async function waitForRuntimeRequestResult<T = Record<string, unknown>>(
  requests: Pick<RuntimeRequestRepo, "getRequest">,
  requestId: string,
  timeoutMs: number,
  failureIdSource: "request" | "record" = "record",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const request = await requests.getRequest(requestId);
    if (request.status === "completed") {
      return (request.result ?? {}) as T;
    }
    if (request.status === "failed") {
      const failedId = failureIdSource === "request" ? requestId : request.id;
      throw new Error(request.error ?? `Runtime request ${failedId} failed.`);
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for runtime request ${requestId}.`);
}
