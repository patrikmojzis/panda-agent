import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_WATCH_CLAIM_OWNERSHIP: PostgresMigrationSummary = Object.freeze({
  id: "0022_watch_claim_ownership",
  description: "Fence watch evaluations and retire legacy claims without replay",
  checksum: "acf64de06e3f988ffc3dab0ea065f809b8443f982f49c0e61d0068088ed6c30d",
});
