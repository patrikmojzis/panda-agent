import {describe, expect, it} from "vitest";

import {
  isExactWhatsAppActorJid,
  resolveWhatsAppManagementActions,
  resolveWhatsAppSetupStage,
} from "../apps/control-ui/src/features/control/agent/whatsapp-setup-model.js";

describe("WhatsApp Control setup model", () => {
  it("moves an account through create, link, connected, disabled, and recovery states", () => {
    expect(resolveWhatsAppSetupStage({hasAccount: false})).toBe("create");
    expect(resolveWhatsAppSetupStage({hasAccount: true})).toBe("loading");
    expect(resolveWhatsAppSetupStage({
      hasAccount: true,
      account: {authStored: false, enabled: false, linked: false},
    })).toBe("link");
    expect(resolveWhatsAppSetupStage({
      hasAccount: true,
      attemptState: "awaiting_confirmation",
      account: {authStored: false, enabled: false, linked: false},
    })).toBe("linking");
    expect(resolveWhatsAppSetupStage({
      hasAccount: true,
      account: {authStored: true, enabled: true, linked: true},
    })).toBe("connected");
    expect(resolveWhatsAppSetupStage({
      hasAccount: true,
      account: {authStored: true, enabled: false, linked: true},
    })).toBe("disabled");
    expect(resolveWhatsAppSetupStage({
      hasAccount: true,
      account: {authStored: true, enabled: false, linked: false},
    })).toBe("reset_required");
    expect(resolveWhatsAppSetupStage({
      hasAccount: true,
      account: {authStored: true, enabled: false, linked: true, status: "error"},
    })).toBe("error");
  });

  it("accepts only exact WhatsApp actor JIDs", () => {
    expect(isExactWhatsAppActorJid("246664333885442@lid")).toBe(true);
    expect(isExactWhatsAppActorJid("421900123456@s.whatsapp.net")).toBe(true);
    expect(isExactWhatsAppActorJid("+421 900 123 456")).toBe(false);
    expect(isExactWhatsAppActorJid("421900123456")).toBe(false);
  });

  it("offers lifecycle actions that are valid for the current account state", () => {
    expect(resolveWhatsAppManagementActions({enabled: true, linked: true, status: "enabled"}))
      .toEqual({canDisable: true, canEnable: false, canReset: false});
    expect(resolveWhatsAppManagementActions({enabled: false, linked: true, status: "disabled"}))
      .toEqual({canDisable: false, canEnable: true, canReset: true});
    expect(resolveWhatsAppManagementActions({enabled: false, linked: true, status: "error"}))
      .toEqual({canDisable: false, canEnable: false, canReset: true});
  });
});
