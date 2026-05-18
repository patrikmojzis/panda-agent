import type {IncomingMessage} from "node:http";

import {isRecord} from "../../lib/records.js";
import {readJsonHttpBody} from "../http-body.js";
import {AgentAppRequestError} from "./http-errors.js";

const MAX_AGENT_APP_JSON_BODY_BYTES = 256 * 1024;

function createAgentAppBodyError(statusCode: number, message: string): AgentAppRequestError {
  return new AgentAppRequestError(statusCode, message);
}

export async function readAgentAppJsonBody(request: IncomingMessage): Promise<unknown> {
  return readJsonHttpBody(request, {
    createError: createAgentAppBodyError,
    invalidJsonPrefix: "Request body must be valid JSON",
    maxBytes: MAX_AGENT_APP_JSON_BODY_BYTES,
    tooLargeMessage: "App request body is too large.",
  });
}

export function readAgentAppBodyRecord(
  value: unknown,
  options: {
    allowMissing?: boolean;
    label?: string;
  } = {},
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (options.allowMissing && (value === undefined || value === null)) {
    return {};
  }

  throw new AgentAppRequestError(400, `${options.label ?? "App request body"} must be a JSON object.`);
}
