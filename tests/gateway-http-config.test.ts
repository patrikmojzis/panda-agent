import {describe, expect, it} from "vitest";

import {
  DEFAULT_GATEWAY_HAE_JSON_INBOX_DIR,
  DEFAULT_GATEWAY_HAE_JSON_MAX_BYTES,
  DEFAULT_GATEWAY_HAE_JSON_SOURCE,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  resolveGatewayHttpConfig,
} from "../src/integrations/gateway/http-config.js";

describe("gateway HTTP config", () => {
  it("resolves defaults and explicit env values outside the route dispatcher", () => {
    expect(resolveGatewayHttpConfig({})).toMatchObject({
      host: DEFAULT_GATEWAY_HOST,
      port: DEFAULT_GATEWAY_PORT,
      tokenTtlMs: 900_000,
      maxActiveTokensPerSource: 20,
      maxTextBytes: 65_536,
      rateLimitPerMinute: 120,
      textBytesPerHour: 5_242_880,
      maxAttachmentBytes: 10_485_760,
      maxAttachmentsPerEvent: 5,
      maxEventAttachmentBytes: 26_214_400,
      attachmentBytesPerHour: 104_857_600,
      maxPendingAttachmentsPerSource: 100,
      attachmentUploadTtlMs: 3_600_000,
      attachmentRetentionMs: 604_800_000,
      attachmentQuarantineTtlMs: 86_400_000,
      attachmentAllowedMimeTypes: expect.arrayContaining(["image/png", "application/pdf"]),
    });
    expect(resolveGatewayHttpConfig({}).haeJsonIngest).toBeUndefined();

    expect(resolveGatewayHttpConfig({
      GATEWAY_HOST: "0.0.0.0",
      GATEWAY_PORT: "8095",
      GATEWAY_ACCESS_TOKEN_TTL_MS: "1000",
      GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE: "2",
      GATEWAY_MAX_TEXT_BYTES: "256",
      GATEWAY_RATE_LIMIT_PER_MINUTE: "3",
      GATEWAY_TEXT_BYTES_PER_HOUR: "4096",
      GATEWAY_MAX_ATTACHMENT_BYTES: "1024",
      GATEWAY_MAX_ATTACHMENTS_PER_EVENT: "2",
      GATEWAY_MAX_EVENT_ATTACHMENT_BYTES: "2048",
      GATEWAY_ATTACHMENT_BYTES_PER_HOUR: "8192",
      GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE: "7",
      GATEWAY_ATTACHMENT_UPLOAD_TTL_MS: "60000",
      GATEWAY_ATTACHMENT_RETENTION_MS: "120000",
      GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS: "30000",
      GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES: "text/plain,image/png",
      GATEWAY_HAE_JSON_TOKEN: "synthetic-hae-token",
      GATEWAY_HAE_JSON_INBOX_DIR: "/tmp/synthetic-hae-inbox",
      GATEWAY_HAE_JSON_MAX_BYTES: "12345",
      GATEWAY_HAE_JSON_SOURCE: "synthetic-hae",
    })).toMatchObject({
      host: "0.0.0.0",
      port: 8095,
      tokenTtlMs: 1000,
      maxActiveTokensPerSource: 2,
      maxTextBytes: 256,
      rateLimitPerMinute: 3,
      textBytesPerHour: 4096,
      maxAttachmentBytes: 1024,
      maxAttachmentsPerEvent: 2,
      maxEventAttachmentBytes: 2048,
      attachmentBytesPerHour: 8192,
      maxPendingAttachmentsPerSource: 7,
      attachmentUploadTtlMs: 60_000,
      attachmentRetentionMs: 120_000,
      attachmentQuarantineTtlMs: 30_000,
      attachmentAllowedMimeTypes: ["text/plain", "image/png"],
      haeJsonIngest: {
        token: "synthetic-hae-token",
        inboxDir: "/tmp/synthetic-hae-inbox",
        maxBytes: 12345,
        source: "synthetic-hae",
      },
    });
  });


  it("enables HAE JSON ingest only when its dedicated token is configured", () => {
    expect(resolveGatewayHttpConfig({
      GATEWAY_HAE_JSON_TOKEN: " token-with-spaces ",
    })).toMatchObject({
      haeJsonIngest: {
        token: "token-with-spaces",
        inboxDir: DEFAULT_GATEWAY_HAE_JSON_INBOX_DIR,
        maxBytes: DEFAULT_GATEWAY_HAE_JSON_MAX_BYTES,
        source: DEFAULT_GATEWAY_HAE_JSON_SOURCE,
      },
    });

    expect(() => resolveGatewayHttpConfig({
      GATEWAY_HAE_JSON_INBOX_DIR: "/tmp/synthetic-hae-inbox",
    })).toThrow("GATEWAY_HAE_JSON_TOKEN is required when configuring HAE JSON ingest.");
  });

  it("rejects invalid ports before the server starts", () => {
    expect(() => resolveGatewayHttpConfig({
      GATEWAY_PORT: "70000",
    })).toThrow("Invalid gateway port: 70000.");
  });
});
