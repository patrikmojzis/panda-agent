import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_CHANNEL_ACTION_EXPIRY: PostgresMigrationSummary = Object.freeze({
  id: "0017_channel_action_expiry",
  description: "Add channel-action expiry and terminalize stale typing presence",
  checksum: "1e4f4c3f0fdfa02962903daae534254e888c94e4cb90aa92e206afd7b70e6534",
});
