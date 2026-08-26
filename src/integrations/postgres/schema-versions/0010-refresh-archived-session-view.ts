import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_REFRESH_ARCHIVED_SESSION_VIEW: PostgresMigrationSummary = Object.freeze({
  id: "0010_refresh_archived_session_view",
  description: "Expose session archive state through the scoped readonly view",
  checksum: "0df6a33d2a39bbfaf2b59c0c00296172002400de9808bed8059c3309ff204193",
});
