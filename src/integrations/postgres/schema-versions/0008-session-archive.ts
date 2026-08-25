import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_SESSION_ARCHIVE: PostgresMigrationSummary = Object.freeze({
  id: "0008_session_archive",
  description: "Archive branch sessions behind durable runtime admission fences",
  checksum: "b8aa55dd789cb3862d6ca5fb52819f2d905dbb6d06d6ea21ad0ea442cbc264cc",
});
