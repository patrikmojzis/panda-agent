import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_SESSION_ARCHIVE: PostgresMigrationSummary = Object.freeze({
  id: "0009_archive_session",
  description: "Archive branch sessions behind durable runtime admission fences",
  checksum: "90e815275fb1aa6bdb31268c47cc9dfd1fcaf93651cb25da924e7228d134fb20",
});
