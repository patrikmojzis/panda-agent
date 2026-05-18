import type {IncomingMessage, ServerResponse} from "node:http";

import {GatewayHttpError, readGatewayTokenRequest} from "./http-body.js";

interface GatewayAccessTokenStore {
  createAccessToken(input: {
    sourceId: string;
    expiresInMs: number;
    maxActiveTokens: number;
  }): Promise<{
    expiresAt: number;
    token: string;
  }>;
  verifyClientCredentials(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<{sourceId: string} | null>;
}

export async function issueGatewayAccessToken(input: {
  maxActiveTokensPerSource: number;
  request: IncomingMessage;
  response: ServerResponse;
  store: GatewayAccessTokenStore;
  tokenTtlMs: number;
}): Promise<{
  access_token: string;
  expires_in: number;
  token_type: "Bearer";
}> {
  const tokenRequest = await readGatewayTokenRequest(input.request);
  const source = await input.store.verifyClientCredentials(tokenRequest);
  if (!source) {
    throw new GatewayHttpError(401, "Invalid client credentials.");
  }
  const access = await input.store.createAccessToken({
    sourceId: source.sourceId,
    expiresInMs: input.tokenTtlMs,
    maxActiveTokens: input.maxActiveTokensPerSource,
  });

  input.response.setHeader("cache-control", "no-store");
  input.response.setHeader("pragma", "no-cache");
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: Math.floor((access.expiresAt - Date.now()) / 1000),
  };
}
