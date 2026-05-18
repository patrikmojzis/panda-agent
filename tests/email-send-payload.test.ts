import {describe, expect, it} from "vitest";

import {
  emailSendPayloadToJsonObject,
  type EmailSendPayload,
} from "../src/domain/email/send-payload.js";

function validEmailPayload(): EmailSendPayload {
  return {
    kind: "email_send",
    agentKey: "panda",
    accountKey: "work",
    fromAddress: "panda@example.com",
    to: [{address: "alice@example.com"}],
    cc: [],
    subject: "Deploy update",
    text: "The deploy step is failing.",
    attachments: [],
    threadKey: "subject:Deploy update",
  };
}

describe("email send payload", () => {
  it("converts valid email send payloads to JSON metadata", () => {
    expect(emailSendPayloadToJsonObject(validEmailPayload())).toMatchObject({
      kind: "email_send",
      accountKey: "work",
      to: [{address: "alice@example.com"}],
    });
  });

  it("rejects payloads that are not JSON-safe", () => {
    const payload: EmailSendPayload = {
      ...validEmailPayload(),
      attachments: [{
        path: "/tmp/report.pdf",
        sizeBytes: Number.NaN,
      }],
    };

    expect(() => emailSendPayloadToJsonObject(payload)).toThrow("Email send payload must be JSON-safe.");
  });
});
