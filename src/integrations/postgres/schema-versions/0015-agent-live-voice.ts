import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_AGENT_LIVE_VOICE: PostgresMigrationSummary = Object.freeze({
  id: "0015_agent_live_voice",
  description: "Add per-agent live voice and immutable call snapshots",
  checksum: "cb29a6e00f5709687659cd807bcef7a9a18a5c5410c4d73269ff3b2a2f1dfd05",
});
