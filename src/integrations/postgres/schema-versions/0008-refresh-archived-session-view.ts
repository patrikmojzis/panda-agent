import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_REFRESH_ARCHIVED_SESSION_VIEW: PostgresMigrationSummary = Object.freeze({
  id: "0008_refresh_archived_session_view",
  description: "Expose session archive state through the scoped readonly view",
  checksum: "3cc0691688df05196ca7080ce65a024b4774fd54368775456091d3b0e0aa14e0",
});
