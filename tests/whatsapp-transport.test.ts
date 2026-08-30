import {describe, expect, it, vi} from "vitest";

import {createWhatsAppPairingLogger} from "../src/integrations/channels/whatsapp/transport.js";

describe("WhatsApp pairing diagnostics", () => {
  it("emits only allowlisted notification metadata", () => {
    const log = vi.fn();
    const logger = createWhatsAppPairingLogger(log);

    logger.info({
      notificationType: "companion_reg_refresh",
      childTags: ["refresh", "device"],
      registered: false,
      node: {attrs: {from: "private-jid"}, content: "secret"},
      pairingCode: "secret-code",
    }, "panda pairing notification");

    expect(log).toHaveBeenCalledWith("pairing_protocol_notification", {
      notificationType: "companion_reg_refresh",
      childTags: ["refresh", "device"],
      registered: false,
    });
  });

  it("ignores all ordinary Baileys logs", () => {
    const log = vi.fn();
    const logger = createWhatsAppPairingLogger(log);

    logger.info({node: {content: "secret"}}, "handling notification");
    logger.warn({pairingCode: "secret-code"}, "unexpected log");

    expect(log).not.toHaveBeenCalled();
  });

  it("reports notification acknowledgement failure without its payload", () => {
    const log = vi.fn();
    const logger = createWhatsAppPairingLogger(log);

    logger.error({ackErr: new Error("contains a private identifier")}, "failed to ack notification");

    expect(log).toHaveBeenCalledWith("pairing_protocol_ack_failed", {});
  });
});
