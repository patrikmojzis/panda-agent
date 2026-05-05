import {describe, expect, it} from "vitest";

import {parseEmailAuthenticationResults} from "../src/domain/email/index.js";

describe("email authentication parsing", () => {
  it("keeps authentication passes unknown because raw headers are not trusted", () => {
    expect(parseEmailAuthenticationResults(
      "mx.example; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
    )).toEqual({
      authSpf: "pass",
      authDkim: "pass",
      authDmarc: "pass",
      authSummary: "unknown",
    });
  });

  it("marks any provider authentication failure as suspicious", () => {
    expect(parseEmailAuthenticationResults(
      "mx.example; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=fail header.from=evil.example",
    )).toEqual({
      authSpf: "pass",
      authDkim: "pass",
      authDmarc: "fail",
      authSummary: "suspicious",
    });
  });

  it("does not treat SPF or DKIM alone as trusted without DMARC pass", () => {
    expect(parseEmailAuthenticationResults(
      "mx.example; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com",
    )).toEqual({
      authSpf: "pass",
      authDkim: "pass",
      authSummary: "unknown",
    });
  });

  it("marks missing provider authentication as unknown", () => {
    expect(parseEmailAuthenticationResults(undefined)).toEqual({
      authSummary: "unknown",
    });
  });
});
