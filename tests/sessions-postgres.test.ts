import {describe, expect, it, vi} from "vitest";

import {PostgresSessionStore} from "../src/domain/sessions/index.js";

describe("PostgresSessionStore", () => {
  it("rejects corrupted persisted session and heartbeat rows before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "session-main",
          agent_key: "panda",
          kind: "sidecar",
          current_thread_id: "thread-main",
          created_by_identity_id: null,
          metadata: {},
          created_at: now,
          updated_at: now,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          session_id: "session-main",
          enabled: "yes",
          every_minutes: 60,
          next_fire_at: now,
          last_fire_at: null,
          last_skip_reason: null,
          claimed_at: null,
          claimed_by: null,
          claim_expires_at: null,
          created_at: now,
          updated_at: now,
        }],
      });
    const store = new PostgresSessionStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(store.getSession("session-main")).rejects.toThrow(
      "Unsupported session kind sidecar.",
    );
    await expect(store.getHeartbeat("session-main")).rejects.toThrow(
      "Session heartbeat enabled flag must be a boolean.",
    );
  });

  it("rejects driver-shaped persisted heartbeat intervals before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        session_id: "session-main",
        enabled: true,
        every_minutes: "60",
        next_fire_at: now,
        last_fire_at: null,
        last_skip_reason: null,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
        created_at: now,
        updated_at: now,
      }],
    });
    const store = new PostgresSessionStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(store.getHeartbeat("session-main")).rejects.toThrow(
      "Session heartbeat interval must be a positive integer.",
    );
  });
});
