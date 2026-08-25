import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_THREAD_ABORT_OPERATIONS: PostgresMigrationSummary = Object.freeze({
  id: "0004_thread_abort_operations",
  description: "Bind replayed abort requests to their original run",
  checksum: "b9776da02eb537b94ab856097421d87b2ecd1430a659bf4544a2dda4d4bf3c21",
});
