import {describe, expect, it} from "vitest";

import {parseWhatsAppMetaCallingConfig} from "../src/integrations/channels/whatsapp/calls/config.js";

describe("WhatsApp Meta Calling config", () => {
  it("preserves Baileys as the absent-mode default and validates Cloud Calling", () => {
    expect(parseWhatsAppMetaCallingConfig({config: {}})).toBeNull();
    expect(parseWhatsAppMetaCallingConfig({config: {mode: "meta_cloud", calling: {enabled: true, phoneNumberId: "123", wabaId: "456", graphVersion: "v23.0"}}})).toEqual({mode: "meta_cloud", calling: {enabled: true, phoneNumberId: "123", wabaId: "456", graphVersion: "v23.0"}});
    expect(() => parseWhatsAppMetaCallingConfig({config: {mode: "meta_cloud"}})).toThrow("missing enabled Calling configuration");
    expect(() => parseWhatsAppMetaCallingConfig({config: {mode: "private"}})).toThrow("Unsupported WhatsApp connector mode");
  });
});
