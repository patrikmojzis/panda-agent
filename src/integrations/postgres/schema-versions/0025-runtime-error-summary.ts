import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_RUNTIME_ERROR_SUMMARY: PostgresMigrationSummary = Object.freeze({
  id: "0025_runtime_error_summary",
  description: "Persist sanitized run failures for scoped Control search and pagination",
  checksum: "849133ebbd02cce532d56faafe82a7ca1e9fcdce3ba7a1e17f77f5ae74afd266",
});
