import {describe, expect, it, vi} from "vitest";

import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";

describe("Postgres thread runtime abort delivery", () => {
  it("records the operation, abort target, and notification in one statement", async () => {
    const runRow = {
      id: "57f29909-2b6e-4ba5-8c50-b8d880a50d84",
      thread_id: "postgres-abort-thread",
      status: "running",
      started_at: new Date("2026-08-24T20:00:00.000Z"),
      abort_requested_at: new Date("2026-08-24T20:01:00.000Z"),
      abort_reason: "stop from postgres",
    };
    const requestAbort = vi.fn(async () => ({rows: [{
      thread_found: true,
      operation_found: true,
      operation_thread_id: "postgres-abort-thread",
      operation_reason: "stop from postgres",
      operation_run_id: runRow.id,
      ...runRow,
      notification_count: 1,
    }]}));
    const pool = {
      query: requestAbort,
      connect: vi.fn(),
    };
    const store = new PostgresThreadRuntimeStore({pool});

    await expect(store.requestRunAbort(
      "postgres-abort-thread",
      "stop from postgres",
      "00000000-0000-0000-0000-000000000901",
    ))
      .resolves.toMatchObject({id: runRow.id, abortReason: "stop from postgres"});

    const updateSql = requestAbort.mock.calls[0]?.[0] ?? "";
    expect(updateSql).toContain('INSERT INTO "runtime"."thread_abort_operations"');
    expect(updateSql).toContain("abort_requested_at = COALESCE(run.abort_requested_at, NOW())");
    expect(updateSql).toMatch(/UPDATE[\s\S]+FROM inserted_operation/);
    expect(updateSql).toMatch(/resolved_run[\s\S]+INNER JOIN existing_operation/);
    expect(updateSql).toContain("pg_notify(");
    expect(requestAbort.mock.calls[0]?.[1]).toEqual([
      "postgres-abort-thread",
      "stop from postgres",
      "00000000-0000-0000-0000-000000000901",
      "runtime_events",
    ]);
    pool.query.mockClear();
    await expect(store.listAbortRequestedRuns([])).resolves.toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    pool.query.mockResolvedValueOnce({rows: [{...runRow, status: "failed"}]});
    await expect(store.listAbortRequestedRuns([runRow.id])).resolves.toMatchObject([{
      id: runRow.id,
      status: "failed",
      abortReason: "stop from postgres",
    }]);
    expect(pool.query.mock.calls[0]?.[0]).not.toContain("status = 'running'");
  });

  it("surfaces a failed atomic abort statement without a second transaction round trip", async () => {
    const query = vi.fn(async () => {
      throw new Error("notification failed");
    });
    const store = new PostgresThreadRuntimeStore({
      pool: {
        query,
        connect: vi.fn(),
      },
    });

    await expect(store.requestRunAbort(
      "rollback-abort-thread",
      "stop",
      "00000000-0000-0000-0000-000000000902",
    ))
      .rejects.toThrow("notification failed");
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects a receipt bound to another thread even when its reason matches", async () => {
    const query = vi.fn(async () => ({rows: [{
      thread_found: true,
      operation_found: true,
      operation_thread_id: "other-thread",
      operation_reason: "same reason",
      operation_run_id: null,
      notification_count: 0,
    }]}));
    const store = new PostgresThreadRuntimeStore({pool: {query, connect: vi.fn()}});

    await expect(store.requestRunAbort(
      "requested-thread",
      "same reason",
      "00000000-0000-0000-0000-000000000903",
    )).rejects.toThrow("conflicts with another request");
    expect(query).toHaveBeenCalledOnce();
  });

  it("retries a same-operation insert that committed after the first snapshot", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows: [{
        thread_found: true,
        operation_found: false,
        operation_thread_id: null,
        operation_reason: null,
        operation_run_id: null,
        notification_count: 0,
      }]})
      .mockResolvedValueOnce({rows: [{
        thread_found: true,
        operation_found: true,
        operation_thread_id: "retry-thread",
        operation_reason: "stop",
        operation_run_id: null,
        notification_count: 0,
      }]});
    const store = new PostgresThreadRuntimeStore({pool: {query, connect: vi.fn()}});

    await expect(store.requestRunAbort(
      "retry-thread",
      "stop",
      "00000000-0000-0000-0000-000000000904",
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
