import {describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../src/app/database/migration-catalog.js";

const PRODUCTION_APPLIED_PREFIX = Object.freeze([
  "0001_pre_ledger_baseline",
  "0002_thread_input_admission",
  "0003_thread_wake_generation",
  "0004_thread_abort_operations",
  "0005_runtime_operation_receipts",
  "0006_thread_input_cutoffs",
  "0007_reset_run_fences",
  "0008_legacy_schema_reconciliation",
]);

describe("production migration prefix", () => {
  it("keeps every deployed migration before unpublished schema work", () => {
    expect(PANDA_SCHEMA_MIGRATIONS.slice(0, PRODUCTION_APPLIED_PREFIX.length).map(({id}) => id))
      .toEqual(PRODUCTION_APPLIED_PREFIX);
  });
});
