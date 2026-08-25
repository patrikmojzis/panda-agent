import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_RESET_RUN_FENCES: PostgresMigrationSummary = Object.freeze({
  id: "0007_reset_run_fences",
  description: "Fence retired reset threads from new run claims",
  checksum: "7d888fe8e93dc4ac6fd4ab03e92d8cbe6c2d6bc2add71c7c0946e474089e13d1",
});
