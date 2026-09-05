import {beforeEach, describe, expect, it, vi} from "vitest";

const observeServiceMocks = vi.hoisted(() => ({
  assertCurrent: vi.fn<() => Promise<void>>(),
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn<() => Promise<void>>(),
  },
}));

vi.mock("../src/lib/postgres-database.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/postgres-database.js")>(),
  createPostgresPool: () => observeServiceMocks.pool,
  requireDatabaseUrl: (value?: string) => value ?? "postgresql://example/panda",
}));

vi.mock("../src/integrations/postgres/schema-version.js", () => ({
  createPandaSchemaVerifier: () => ({assertCurrent: observeServiceMocks.assertCurrent}),
}));

import {createObserveServices} from "../src/ui/observe/app.js";

describe("Observe services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observeServiceMocks.assertCurrent.mockResolvedValue();
    observeServiceMocks.pool.end.mockResolvedValue();
  });

  it("verifies the schema before exposing read-only stores", async () => {
    const services = await createObserveServices("postgresql://example/panda");

    expect(observeServiceMocks.assertCurrent).toHaveBeenCalledOnce();
    await services.close();
    expect(observeServiceMocks.pool.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when schema verification fails", async () => {
    observeServiceMocks.assertCurrent.mockRejectedValueOnce(new Error("schema drift"));

    await expect(createObserveServices("postgresql://example/panda"))
      .rejects.toThrow("schema drift");
    expect(observeServiceMocks.pool.end).toHaveBeenCalledOnce();
  });
});
