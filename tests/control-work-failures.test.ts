import {describe, expect, it, vi} from "vitest";

import {readControlWorkFailures} from "../src/domain/control/work-failures.js";
import type {PgPoolLike} from "../src/lib/postgres-query.js";

function unavailablePool(): PgPoolLike {
  return {query: vi.fn().mockRejectedValue(new Error("Unexpected pool query")), connect: vi.fn().mockRejectedValue(new Error("private connection detail"))};
}

describe("Control failure snapshot boundaries", () => {
  it("returns an empty scoped page without checking out a database client", async () => {
    const pool = unavailablePool();
    expect(await readControlWorkFailures(pool, [], {page: 3, perPage: 200})).toEqual({
      data: [], counts: {total: 0, critical: 0, warning: 0}, meta: {current_page: 3, last_page: 1, per_page: 100, total: 0},
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("hides connection details from the public error while retaining its cause", async () => {
    await expect(readControlWorkFailures(unavailablePool(), ["panda"]))
      .rejects.toMatchObject({message: "Work failure snapshot could not be read.", cause: expect.any(Error)});
  });

  it("rolls back and releases its only client when a configured source cannot be read", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || sql === "ROLLBACK") return {rows: []};
      throw new Error("private query detail");
    });
    const pool: PgPoolLike = {...unavailablePool(), connect: vi.fn(async () => ({query, release}))};
    await expect(readControlWorkFailures(pool, ["panda"], {kind: "runtime_run"}))
      .rejects.toMatchObject({message: "Work failure snapshot could not be read.", cause: expect.any(Error)});
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it("commits an empty snapshot when its selected optional source is absent", async () => {
    const release = vi.fn();
    const query = vi.fn(async () => ({rows: []}));
    const pool: PgPoolLike = {...unavailablePool(), connect: async () => ({query, release})};
    expect(await readControlWorkFailures(pool, ["panda"], {kind: "channel_action"})).toMatchObject({data: [], counts: {total: 0}});
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});
