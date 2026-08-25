import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_RUNTIME_OPERATION_RECEIPTS: PostgresMigrationSummary = Object.freeze({
  id: "0005_runtime_operation_receipts",
  description: "Retain replay receipts and execution attempts with their runtime requests",
  checksum: "551f0bf5ea7430e2fc769c3c2a86043d03f06b97dabd3c93b3c9228580dae50e",
});
