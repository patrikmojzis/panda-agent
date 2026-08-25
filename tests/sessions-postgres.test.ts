import {describe, expect, it, vi} from "vitest";

import {PostgresSessionStore} from "../src/domain/sessions/index.js";

describe("PostgresSessionStore", () => {
  it("uses explicit lifecycle predicates when listing sessions", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [{
        id: "session-branch",
        agent_key: "panda",
        kind: "branch",
        current_thread_id: "thread-branch",
        created_by_identity_id: null,
        alias: null,
        display_name: null,
        metadata: null,
        archived_at: now,
        created_at: now,
        updated_at: now,
      }],
    }));
    const store = new PostgresSessionStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(store.listAgentSessions("panda", {lifecycle: "archived"}))
      .resolves.toMatchObject([{id: "session-branch", archivedAt: now.getTime()}]);
    expect(query.mock.calls[0]?.[0]).toContain("session.archived_at IS NOT NULL");
    await store.listAgentSessions("panda", {lifecycle: "all"});
    expect(query.mock.calls[1]?.[0]).not.toContain("archived_at IS");
  });

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
