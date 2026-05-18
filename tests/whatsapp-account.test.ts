import {describe, expect, it} from "vitest";

import {toWhatsAppWhoamiResult} from "../src/integrations/channels/whatsapp/account.js";

describe("whatsapp account", () => {
  it("does not expose unregistered credentials as a linked account", () => {
    expect(toWhatsAppWhoamiResult("main", {
      registered: false,
      me: {
        id: "421900000000@s.whatsapp.net",
        name: "Alice",
      },
    })).toEqual({
      connectorKey: "main",
      registered: false,
      accountId: undefined,
      phoneNumber: undefined,
      name: undefined,
    });
  });

  it("normalizes linked account display fields", () => {
    expect(toWhatsAppWhoamiResult("main", {
      registered: true,
      me: {
        id: "  421900000000@s.whatsapp.net  ",
        phoneNumber: "  421900000000  ",
        name: "  ",
        notify: " Alice ",
      },
    })).toEqual({
      connectorKey: "main",
      registered: true,
      accountId: "421900000000@s.whatsapp.net",
      phoneNumber: "421900000000",
      name: "Alice",
    });
  });
});
