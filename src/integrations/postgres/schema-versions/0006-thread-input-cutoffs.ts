import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_THREAD_INPUT_CUTOFFS: PostgresMigrationSummary = Object.freeze({
  id: "0006_thread_input_cutoffs",
  description: "Replace per-input admission writes with run cutoffs",
  checksum: "aeb5e9e0d3c3c365a72e6824988bb566f622b1f16e9236f731a402c65d7a4ea3",
});
