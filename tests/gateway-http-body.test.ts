import type {IncomingMessage} from "node:http";
import {Readable} from "node:stream";

import {describe, expect, it} from "vitest";

import {
  GatewayHttpError,
  readGatewayJsonBody,
  readGatewayRawBody,
  readGatewayTokenRequest,
} from "../src/integrations/gateway/http-body.js";

function createRequest(body: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    headers,
  }) as IncomingMessage;
}

describe("gateway HTTP body parsing", () => {
  it("rejects declared and streamed bodies over the byte limit", async () => {
    await expect(readGatewayRawBody(createRequest("", {"content-length": "10"}), 5))
      .rejects.toMatchObject({
        statusCode: 413,
        message: "Request body is too large.",
      });

    await expect(readGatewayRawBody(createRequest("abcdef"), 5))
      .rejects.toMatchObject({
        statusCode: 413,
        message: "Request body is too large.",
      });
  });

  it("parses JSON bodies and reports bad JSON as gateway HTTP errors", async () => {
    await expect(readGatewayJsonBody(createRequest(" {\"ok\": true} "), 1024)).resolves.toEqual({ok: true});
    await expect(readGatewayJsonBody(createRequest(""), 1024)).resolves.toEqual({});

    await expect(readGatewayJsonBody(createRequest("{"), 1024))
      .rejects.toBeInstanceOf(GatewayHttpError);
    await expect(readGatewayJsonBody(createRequest("{"), 1024))
      .rejects.toMatchObject({
        statusCode: 400,
      });
  });

  it("parses OAuth token requests from JSON and form bodies", async () => {
    await expect(readGatewayTokenRequest(createRequest(JSON.stringify({
      grant_type: "client_credentials",
      client_id: "source",
      client_secret: "secret",
    }), {"content-type": "application/json"}))).resolves.toEqual({
      clientId: "source",
      clientSecret: "secret",
    });

    await expect(readGatewayTokenRequest(createRequest(new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "source",
      client_secret: "secret",
    }).toString(), {"content-type": "application/x-www-form-urlencoded"}))).resolves.toEqual({
      clientId: "source",
      clientSecret: "secret",
    });
  });

  it("rejects invalid OAuth token body shapes", async () => {
    await expect(readGatewayTokenRequest(createRequest("[]", {"content-type": "application/json"})))
      .rejects.toMatchObject({
        statusCode: 400,
        message: "Token request body must be an object.",
      });

    await expect(readGatewayTokenRequest(createRequest(new URLSearchParams({
      grant_type: "password",
      client_id: "source",
      client_secret: "secret",
    }).toString(), {"content-type": "application/x-www-form-urlencoded"}))).rejects.toMatchObject({
      statusCode: 400,
      message: "Unsupported grant_type.",
    });
  });

  it("rejects OAuth token requests without a supported content type", async () => {
    await expect(readGatewayTokenRequest(createRequest(new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "source",
      client_secret: "secret",
    }).toString()))).rejects.toMatchObject({
      statusCode: 415,
      message: "Unsupported Content-Type. Expected application/json or application/x-www-form-urlencoded.",
    });

    await expect(readGatewayTokenRequest(createRequest("client_id=source", {
      "content-type": "text/plain",
    }))).rejects.toMatchObject({
      statusCode: 415,
      message: "Unsupported Content-Type. Expected application/json or application/x-www-form-urlencoded.",
    });
  });
});
