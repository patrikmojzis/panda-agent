import type {IncomingMessage} from "node:http";
import {Readable} from "node:stream";

import {describe, expect, it} from "vitest";

import {
  readAgentAppBodyRecord,
  readAgentAppJsonBody,
} from "../src/integrations/apps/http-body.js";
import {AgentAppRequestError} from "../src/integrations/apps/http-errors.js";

const maxAgentAppJsonBodyBytes = 256 * 1024;

function createRequest(body: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    headers,
  }) as IncomingMessage;
}

describe("app HTTP body parsing", () => {
  it("parses JSON object bodies and optional nested records", async () => {
    await expect(readAgentAppJsonBody(createRequest(" {\"input\": {\"amount\": 1}} ")))
      .resolves.toEqual({input: {amount: 1}});
    await expect(readAgentAppJsonBody(createRequest(""))).resolves.toEqual({});
    expect(readAgentAppBodyRecord({input: {amount: 1}})).toEqual({input: {amount: 1}});
    expect(readAgentAppBodyRecord(undefined, {allowMissing: true})).toEqual({});
    expect(readAgentAppBodyRecord(null, {allowMissing: true})).toEqual({});
  });

  it("rejects non-object JSON bodies and provided nested records", () => {
    expect(() => readAgentAppBodyRecord([])).toThrow("App request body must be a JSON object.");
    expect(() => readAgentAppBodyRecord(null)).toThrow("App request body must be a JSON object.");
    expect(() => readAgentAppBodyRecord([], {
      allowMissing: true,
      label: "App action input",
    })).toThrow("App action input must be a JSON object.");
  });

  it("rejects declared and streamed bodies over the app JSON limit", async () => {
    await expect(readAgentAppJsonBody(createRequest("", {
      "content-length": String(maxAgentAppJsonBodyBytes + 1),
    }))).rejects.toMatchObject({
      statusCode: 413,
      message: "App request body is too large.",
    });

    await expect(readAgentAppJsonBody(createRequest("x".repeat(maxAgentAppJsonBodyBytes + 1))))
      .rejects.toMatchObject({
        statusCode: 413,
        message: "App request body is too large.",
      });
  });

  it("reports invalid JSON as app request errors", async () => {
    await expect(readAgentAppJsonBody(createRequest("{")))
      .rejects.toBeInstanceOf(AgentAppRequestError);
    await expect(readAgentAppJsonBody(createRequest("{")))
      .rejects.toMatchObject({
        statusCode: 400,
      });
  });
});
