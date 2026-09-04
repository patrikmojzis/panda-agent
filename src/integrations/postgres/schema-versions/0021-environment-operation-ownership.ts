import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_ENVIRONMENT_OPERATION_OWNERSHIP: PostgresMigrationSummary = Object.freeze({
  id: "0021_environment_operation_ownership",
  description: "Fence execution environment operations without time-based takeover",
  checksum: "679ff84e54aed550e8636aff8dea852f21085982d7377853df40719dec971498",
});
