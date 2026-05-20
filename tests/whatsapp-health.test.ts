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

  it("derives listener readiness from the Postgres listener snapshot", () => {
    const health = new WhatsAppHealthState({
      connectorKey: "main",
      now: () => 5_000,
    });

    health.resetForRun();
    health.markInitialized(true);
    health.markLockHeld(true);
    health.markSocketState("open");
    health.markListenerSnapshot({
      status: "listening",
      listening: true,
      channels: ["runtime_channel_action_events", "runtime_outbound_delivery_events"],
      lastConnectedAt: 4_000,
      lastErrorAt: null,
      lastError: null,
    });

    expect(health.snapshot(false)).toMatchObject({
      ok: true,
      listenersActive: true,
      listenerStatus: "listening",
      listenerLastErrorAt: null,
      listenerLastError: null,
    });

    health.markListenerSnapshot({
      status: "reconnecting",
      listening: false,
      channels: ["runtime_channel_action_events", "runtime_outbound_delivery_events"],
      lastConnectedAt: 4_000,
      lastErrorAt: 4_500,
      lastError: "listen lost",
    });

    expect(health.snapshot(false)).toMatchObject({
      ok: false,
      listenersActive: false,
      listenerStatus: "reconnecting",
      listenerLastErrorAt: 4_500,
      listenerLastError: "listen lost",
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
