import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {BrowserAction} from "./action-types.js";

export interface BrowserPreviewOriginGrant {
  originalOrigin: string;
  resolvedOrigin: string;
}

export interface BrowserRunnerActionRequest {
  agentKey: string;
  sessionId?: string;
  threadId?: string;
  action: BrowserAction;
  previewOriginGrant?: BrowserPreviewOriginGrant;
}

export interface BrowserRunnerArtifact {
  kind: "image" | "pdf";
  mimeType: string;
  data: string;
  bytes: number;
  path: string;
}

export interface BrowserRunnerActionSuccessResponse {
  ok: true;
  text: string;
  details?: JsonObject;
  artifact?: BrowserRunnerArtifact;
}

export interface BrowserRunnerErrorResponse {
  ok: false;
  error: string;
  details?: JsonObject;
}

export interface BrowserRunnerHealthResponse {
  ok: true;
  status: "ok";
}

export type BrowserRunnerActionResponse = BrowserRunnerActionSuccessResponse | BrowserRunnerErrorResponse;

function isBrowserRunnerArtifact(value: unknown): value is BrowserRunnerArtifact {
  return isJsonObject(value)
    && (value.kind === "image" || value.kind === "pdf")
    && typeof value.mimeType === "string"
    && typeof value.data === "string"
    && typeof value.bytes === "number"
    && Number.isInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.path === "string";
}

export function parseBrowserRunnerActionResponse(value: unknown): BrowserRunnerActionResponse {
  if (!isJsonObject(value) || typeof value.ok !== "boolean") {
    throw new ToolError("Browser runner returned an invalid response.");
  }

  if (value.ok === true) {
    if (
      typeof value.text !== "string"
      || (value.details !== undefined && !isJsonObject(value.details))
      || (value.artifact !== undefined && !isBrowserRunnerArtifact(value.artifact))
    ) {
      throw new ToolError("Browser runner returned an invalid response.");
    }

    return {
      ok: true,
      text: value.text,
      ...(value.details ? {details: value.details} : {}),
      ...(value.artifact ? {artifact: value.artifact} : {}),
    };
  }

  if (typeof value.error !== "string" || (value.details !== undefined && !isJsonObject(value.details))) {
    throw new ToolError("Browser runner returned an invalid response.");
  }

  return {
    ok: false,
    error: value.error,
    ...(value.details ? {details: value.details} : {}),
  };
}
