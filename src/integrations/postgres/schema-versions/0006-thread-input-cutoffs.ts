import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_THREAD_INPUT_CUTOFFS: PostgresMigrationSummary = Object.freeze({
  id: "0006_thread_input_cutoffs",
  description: "Replace per-input admission writes with run cutoffs",
  checksum: "012726c6e1df73fc45cdce8ca1223e0f356461713825262ee5edb1eaea646fcd",
});
