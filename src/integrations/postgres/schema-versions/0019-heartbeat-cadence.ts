import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_HEARTBEAT_CADENCE: PostgresMigrationSummary = Object.freeze({
  id: "0019_heartbeat_cadence",
  description: "Persist heartbeat cadence reasons and fence configuration changes",
  checksum: "9de9d179ec0f7648c29f0dc1de0eae1f747fb9bfb003fb22494406a7ebca1c33",
});
