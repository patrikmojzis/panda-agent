import {describe, expect, it} from "vitest";

import {WhatsAppHealthState} from "../src/integrations/channels/whatsapp/health.js";

describe("WhatsApp health state", () => {
  it("reports healthy only when initialized, locked, listening, and socket-open", () => {
    let now = 1_000;
    const health = new WhatsAppHealthState({
      connectorKey: "main",
      now: () => now,
    });

    health.resetForRun();
    health.markInitialized(true);
    health.markLockHeld(true);
    health.markListenersActive(true);
    health.markSocketState("open");

    expect(health.snapshot(false)).toMatchObject({
      ok: true,
      connectorKey: "main",
      initialized: true,
      lockHeld: true,
      listenersActive: true,
      socketState: "open",
      socketStateAt: 1_000,
      stopping: false,
    });

    now = 2_000;
    health.markListenersActive(false);

    expect(health.snapshot(false)).toMatchObject({
      ok: false,
      listenersActive: false,
      socketState: "open",
    });
  });

  it("keeps reconnecting sockets healthy only inside the reconnect grace window", () => {
    let now = 10_000;
    const health = new WhatsAppHealthState({
      connectorKey: "main",
      reconnectGraceMs: 500,
      now: () => now,
    });

    health.resetForRun();
    health.markInitialized(true);
    health.markLockHeld(true);
    health.markListenersActive(true);
    health.markSocketState("reconnecting");

    now = 10_500;
    expect(health.snapshot(false).ok).toBe(true);

    now = 10_501;
    expect(health.snapshot(false).ok).toBe(false);
  });

  it("marks stop as unhealthy and clears readiness flags", () => {
    const health = new WhatsAppHealthState({
      connectorKey: "main",
      now: () => 3_000,
    });

    health.resetForRun();
    health.markInitialized(true);
    health.markLockHeld(true);
    health.markListenersActive(true);
    health.markSocketState("open");
    health.markStopped();

    expect(health.snapshot(true)).toMatchObject({
      ok: false,
      initialized: false,
      lockHeld: false,
      listenersActive: false,
      socketState: "stopped",
      socketStateAt: 3_000,
      stopping: true,
    });
  });
});
