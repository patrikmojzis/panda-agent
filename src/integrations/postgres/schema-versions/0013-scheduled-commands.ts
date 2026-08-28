import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_SCHEDULED_COMMANDS: PostgresMigrationSummary = Object.freeze({
  id: "0013_scheduled_commands",
  description: "Add session-owned mechanical scheduled commands",
  checksum: "abdfc30b663b9bbcec671c2427fd1f5417e61aed64e7995366347ba3e039ed72",
});
