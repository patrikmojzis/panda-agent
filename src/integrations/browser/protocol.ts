import type {JsonObject} from "../../kernel/agent/types.js";
import type {BrowserAction} from "../../panda/tools/browser-types.js";

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
