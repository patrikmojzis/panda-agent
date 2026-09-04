import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_SESSION_COMPACTION_REQUESTS: PostgresMigrationSummary = Object.freeze({
  id: "0018_session_compaction_requests",
  description: "Add durable agent-requested session compaction",
  checksum: "d8bdd6800582eb0e098b205bf3221393e427dd1b63534311e3361c30af968949",
});
