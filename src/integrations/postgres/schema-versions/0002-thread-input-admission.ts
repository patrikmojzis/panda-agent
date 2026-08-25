import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_THREAD_INPUT_ADMISSION: PostgresMigrationSummary = Object.freeze({
  id: "0002_thread_input_admission",
  description: "Track exact run admission for pending thread inputs",
  checksum: "7c8f025fbd2a6faf46cc3938ac569641de53d147f97b7d3ce910ce4b46c1b85f",
});
