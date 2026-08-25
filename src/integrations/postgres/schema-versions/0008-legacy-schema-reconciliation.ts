import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_LEGACY_SCHEMA_RECONCILIATION: PostgresMigrationSummary = Object.freeze({
  id: "0008_legacy_schema_reconciliation",
  description: "Reconcile legacy schema objects and stable readonly views",
  checksum: "957b7ff1599a18504c8df33b1b672c6d3fa1fe9ee6fd519a9a76fc526182292a",
});
