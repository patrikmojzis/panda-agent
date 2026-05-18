import {DisconnectReason} from "baileys";
import {describe, expect, it} from "vitest";

import {
  describeWhatsAppDisconnectStatus,
  extractWhatsAppDisconnectStatusCode,
  shouldReconnectWhatsApp,
  shouldReconnectWhatsAppPairing,
} from "../src/integrations/channels/whatsapp/connection.js";

describe("whatsapp connection policy", () => {
  it("extracts Boom-style and direct disconnect status codes", () => {
    expect(extractWhatsAppDisconnectStatusCode({
      output: {
        statusCode: 405,
      },
    })).toBe(405);
    expect(extractWhatsAppDisconnectStatusCode({
      statusCode: 428,
    })).toBe(428);
    expect(extractWhatsAppDisconnectStatusCode(new Error("closed"))).toBeNull();
  });

  it("classifies reconnectable run and pairing disconnects", () => {
    expect(shouldReconnectWhatsApp(405)).toBe(true);
    expect(shouldReconnectWhatsApp(DisconnectReason.connectionClosed)).toBe(true);
    expect(shouldReconnectWhatsApp(DisconnectReason.loggedOut)).toBe(false);
    expect(shouldReconnectWhatsAppPairing(DisconnectReason.loggedOut)).toBe(true);
  });

  it("describes known and unknown disconnect statuses", () => {
    expect(describeWhatsAppDisconnectStatus(null)).toBe("unknown");
    expect(describeWhatsAppDisconnectStatus(405)).toBe("405");
  });
});
