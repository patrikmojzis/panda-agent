import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_SESSION_ARCHIVE: PostgresMigrationSummary = Object.freeze({
  id: "0008_archive_session",
  description: "Archive branch sessions behind durable runtime admission fences",
  checksum: "d78695d1bf558b2ed0217b330eae9a35dfd8f32f97a8d5044ef8ba852fed0f3d",
});
