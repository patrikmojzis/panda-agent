import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";
import type {Pool} from "pg";

import {SessionArchivedError} from "../src/domain/threads/runtime/store.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

describe("session heartbeat cadence", () => {
  let pool: Pool;
  let sessions: Awaited<ReturnType<typeof createRuntimeStores>>["sessionStore"];
  let now: number;

  beforeEach(async () => {
    const {Pool} = newDb().adapters.createPg();
    pool = new Pool();
    ({sessionStore: sessions} = await createRuntimeStores(pool));
    await sessions.createSession({
      id: "heartbeat-main", agentKey: "panda", kind: "main", currentThreadId: "heartbeat-thread",
    });
    now = Date.now();
  });

  afterEach(async () => { await pool.end(); });

  it("keeps an identical cadence entirely unchanged, including a live claim and its reason", async () => {
    await sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 30, asOf: now - 3_600_000,
      lastCadenceChangeReason: "Investigation is active",
    });
    const claimed = await sessions.claimHeartbeat({
      sessionId: "heartbeat-main", claimedBy: "claim-a", claimExpiresAt: now + 300_000, asOf: now,
    });
    expect(claimed).not.toBeNull();
    await expect(sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 30, asOf: now,
      lastCadenceChangeReason: "A retry must not rewrite this",
    })).resolves.toEqual(claimed);
  });

  it.each([
    {remainingMinutes: 45, expectedRemainingMinutes: 15},
    {remainingMinutes: 5, expectedRemainingMinutes: 5},
    {remainingMinutes: -5, expectedRemainingMinutes: -5},
  ])("shortens without postponing a tick $remainingMinutes minutes away", async ({remainingMinutes, expectedRemainingMinutes}) => {
    await sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 90,
      asOf: now + (remainingMinutes - 90) * 60_000,
    });
    await expect(sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 15, asOf: now,
      lastCadenceChangeReason: "Review more often",
    })).resolves.toMatchObject({
      enabled: true, everyMinutes: 15, nextFireAt: now + expectedRemainingMinutes * 60_000,
      configRevision: 2, lastCadenceChangeReason: "Review more often",
    });
  });

  it("lengthens from the accepted change and clears a previous agent reason on operator change", async () => {
    await sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 15, asOf: now,
      lastCadenceChangeReason: "Previously urgent",
    });
    await expect(sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 240, asOf: now,
    })).resolves.toMatchObject({
      everyMinutes: 240, nextFireAt: now + 240 * 60_000, lastCadenceChangeReason: undefined,
    });
  });

  it("changes the stored interval without enabling a disabled heartbeat", async () => {
    const disabled = await sessions.updateHeartbeatConfig({sessionId: "heartbeat-main", enabled: false});
    await expect(sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 15, asOf: now,
      lastCadenceChangeReason: "Ready when enabled",
    })).resolves.toMatchObject({
      enabled: false, everyMinutes: 15, nextFireAt: disabled.nextFireAt,
      lastCadenceChangeReason: "Ready when enabled",
    });
    await expect(sessions.listDueHeartbeats({asOf: now + 86_400_000})).resolves.toEqual([]);
  });

  it("preserves the already claimed tick and applies a new cadence to the following tick", async () => {
    await sessions.updateHeartbeatConfig({sessionId: "heartbeat-main", everyMinutes: 90, asOf: now - 7_200_000});
    await sessions.claimHeartbeat({
      sessionId: "heartbeat-main", claimedBy: "claim-a", claimExpiresAt: now + 300_000, asOf: now,
    });
    await expect(sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 15, asOf: now,
    })).resolves.toMatchObject({
      claimedBy: "claim-a", everyMinutes: 15, nextFireAt: now + 15 * 60_000,
    });
  });

  it("revokes an expired claim when changing cadence", async () => {
    await sessions.updateHeartbeatConfig({sessionId: "heartbeat-main", everyMinutes: 90, asOf: now - 7_200_000});
    await sessions.claimHeartbeat({
      sessionId: "heartbeat-main", claimedBy: "expired", claimExpiresAt: now - 1, asOf: now - 2,
    });
    await expect(sessions.updateHeartbeatConfig({
      sessionId: "heartbeat-main", everyMinutes: 120, asOf: now,
    })).resolves.toMatchObject({claimedBy: undefined, nextFireAt: now + 120 * 60_000});
  });

  it("rejects mutations for archived sessions", async () => {
    await sessions.createSession({
      id: "archived-branch", agentKey: "panda", kind: "branch", currentThreadId: "archived-thread",
    });
    await pool.query("UPDATE runtime.agent_sessions SET archived_at = NOW() WHERE id = 'archived-branch'");
    await expect(sessions.updateHeartbeatConfig({sessionId: "archived-branch", everyMinutes: 30}))
      .rejects.toBeInstanceOf(SessionArchivedError);
  });
});
