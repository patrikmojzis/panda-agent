import {describe, expect, it} from "vitest";

import {parseEmailAuthenticationHeaders, parseEmailAuthenticationResults} from "../src/domain/email/auth.js";

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


  it("parses Received-SPF and Rspamd auth evidence when Authentication-Results is absent", () => {
    expect(parseEmailAuthenticationHeaders({
      receivedSpf: "Pass (sender SPF authorized) identity=mailfrom; envelope-from=notifications@github.example",
      xSpamdResult: "default: False [-6.10 / 15.00]; R_SPF_ALLOW(-0.20); R_DKIM_ALLOW(-0.20); DKIM_TRACE(0.00)[github.example:+]; DMARC_POLICY_ALLOW(-0.50)",
    })).toEqual({
      authSpf: "pass",
      authDkim: "pass",
      authDmarc: "pass",
      authSummary: "unknown",
    });
  });

  it("keeps provider-specific auth failures suspicious even when other headers pass", () => {
    expect(parseEmailAuthenticationHeaders({
      authenticationResults: "mx.example; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass",
      receivedSpf: "Pass (sender SPF authorized) identity=mailfrom",
      xSpamdResult: "default: True [8.00 / 15.00]; R_SPF_ALLOW(-0.20); R_SPF_FAIL(5.00); R_DKIM_ALLOW(-0.20); DKIM_TRACE(0.00)[example.com:-]; DMARC_POLICY_REJECT(5.00)",
    })).toEqual({
      authSpf: "fail",
      authDkim: "fail",
      authDmarc: "fail",
      authSummary: "suspicious",
    });
  });

  it("marks missing provider authentication as unknown", () => {
    expect(parseEmailAuthenticationResults(undefined)).toEqual({
      authSummary: "unknown",
    });
  });
});
