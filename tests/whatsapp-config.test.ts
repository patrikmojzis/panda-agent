import {describe, expect, it} from "vitest";

import {
  resolveWhatsAppIngressLimits,
  resolveWhatsAppSocketVersion,
} from "../src/integrations/channels/whatsapp/config.js";

describe("WhatsApp config", () => {
  it("parses an operator-pinned WhatsApp Web version", () => {
    expect(resolveWhatsAppSocketVersion({
      PANDA_WHATSAPP_VERSION: "2.3000.1035194821",
    })).toEqual([2, 3000, 1035194821]);
  });

  it("rejects malformed pinned WhatsApp Web versions", () => {
    expect(() => resolveWhatsAppSocketVersion({
      PANDA_WHATSAPP_VERSION: "2.3000",
    })).toThrow("PANDA_WHATSAPP_VERSION must use <major>.<minor>.<revision> format.");
  });

  it("parses strict positive WhatsApp media limits", () => {
    expect(resolveWhatsAppIngressLimits({
      PANDA_WHATSAPP_MAX_MEDIA_BYTES: "1024",
      PANDA_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS: "5000",
      PANDA_WHATSAPP_MEDIA_CONCURRENCY: "3",
      PANDA_WHATSAPP_MEDIA_QUEUE_MAX: "12",
    })).toEqual({
      maxMediaBytes: 1024,
      mediaDownloadTimeoutMs: 5000,
      mediaConcurrency: 3,
      mediaQueueMax: 12,
    });
    expect(() => resolveWhatsAppIngressLimits({
      PANDA_WHATSAPP_MAX_MEDIA_BYTES: "0",
    })).toThrow("PANDA_WHATSAPP_MAX_MEDIA_BYTES must be a positive integer.");
  });
});
