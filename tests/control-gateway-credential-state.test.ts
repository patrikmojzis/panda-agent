import {afterEach, describe, expect, it} from "vitest";

import {
  gatewayEventTypePayload,
  gatewayEventTypeToFormValues,
  useIssuedGatewayCredentialStore,
} from "../apps/control-ui/src/features/control/gateway/gateway-form-model.js";

afterEach(() => {
  useIssuedGatewayCredentialStore.getState().clearIssuedCredential();
});

describe("Control Gateway one-time credential state", () => {
  it("holds exactly one typed credential and clears it on dismissal", () => {
    useIssuedGatewayCredentialStore.getState().setIssuedCredential({
      kind: "source",
      sourceId: "build-alerts",
      clientId: "pgc_client",
      clientSecret: "pgs_secret",
    });
    expect(useIssuedGatewayCredentialStore.getState().issuedCredential).toEqual({
      kind: "source",
      sourceId: "build-alerts",
      clientId: "pgc_client",
      clientSecret: "pgs_secret",
    });

    useIssuedGatewayCredentialStore.getState().setIssuedCredential({
      kind: "device",
      sourceId: "build-alerts",
      deviceId: "salespanda-vps",
      token: "pgd_token",
    });
    expect(useIssuedGatewayCredentialStore.getState().issuedCredential).toEqual({
      kind: "device",
      sourceId: "build-alerts",
      deviceId: "salespanda-vps",
      token: "pgd_token",
    });

    useIssuedGatewayCredentialStore.getState().clearIssuedCredential();
    expect(useIssuedGatewayCredentialStore.getState().issuedCredential).toBeNull();
  });
});

describe("Control Gateway event type policy model", () => {
  it("round-trips the trusted policy through edit values and API payloads", () => {
    const values = gatewayEventTypeToFormValues({
      sourceId: "build-alerts",
      type: "build.completed",
      delivery: "wake",
      trusted: true,
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
    });

    expect(values).toMatchObject({trusted: true});
    expect(gatewayEventTypePayload(values)).toEqual({
      delivery: "wake",
      trusted: true,
      type: "build.completed",
    });
  });
});
