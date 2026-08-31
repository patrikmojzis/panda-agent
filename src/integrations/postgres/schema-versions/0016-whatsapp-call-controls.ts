import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_WHATSAPP_CALL_CONTROLS: PostgresMigrationSummary = Object.freeze({
  id: "0016_whatsapp_call_controls",
  description: "Add durable WhatsApp live-call controls and turn authority snapshots",
  checksum: "6a594b07a307efb9d32ed746e05038a08e12ffd2e8c6f41dd61d3d2eaa7ac200",
});
