import {describe, expect, it} from "vitest";

import {
  normalizeEmailAddress,
  normalizeEmailAddressDomain,
  normalizeEmailDomain,
  normalizeEmailRecipientAllowRuleValue,
} from "../src/domain/email/shared.js";

describe("email recipient allow rules", () => {
  it("canonicalizes exact addresses and exact domains independently", () => {
    expect(normalizeEmailRecipientAllowRuleValue("address", " ALICE@Company.COM "))
      .toBe("alice@company.com");
    expect(normalizeEmailRecipientAllowRuleValue("domain", " Company.COM "))
      .toBe("company.com");
  });

  it("canonicalizes Unicode and Punycode domains to the same stored value", () => {
    expect(normalizeEmailDomain("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeEmailDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(normalizeEmailAddressDomain("person@BÜCHER.example"))
      .toBe("xn--bcher-kva.example");
  });

  it.each([
    "",
    "company",
    ".company.com",
    "company.com.",
    "staff..company.com",
    "-staff.company.com",
    "staff-.company.com",
    "*@company.com",
    "@company.com",
    "https://company.com",
    "company.com:25",
    "127.0.0.1",
    "[127.0.0.1]",
  ])("rejects non-domain allow-rule input %j", (value) => {
    expect(() => normalizeEmailDomain(value)).toThrow("Invalid email domain");
  });

  it("keeps wildcard-looking addresses literal rather than treating them as domain rules", () => {
    expect(normalizeEmailAddress("*@company.com")).toBe("*@company.com");
    expect(() => normalizeEmailRecipientAllowRuleValue("domain", "*@company.com"))
      .toThrow("Invalid email domain");
  });
});
