import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_THREAD_WAKE_GENERATION: PostgresMigrationSummary = Object.freeze({
  id: "0003_thread_wake_generation",
  description: "Fence concurrent thread wake consumption by generation",
  checksum: "496e26c075c64ec1653533903bc01523e50798a9770da5f7fc222464907dd120",
});
