import {describe, expect, it} from "vitest";

import {resolveWhatsAppConnectorKey, resolveWhatsAppSocketVersion} from "../src/integrations/channels/whatsapp/config.js";

describe("WhatsApp config", () => {
  it("uses main as the default connector key", () => {
    expect(resolveWhatsAppConnectorKey({})).toBe("main");
  });

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
});
