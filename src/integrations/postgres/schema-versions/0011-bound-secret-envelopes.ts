import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_BOUND_SECRET_ENVELOPES: PostgresMigrationSummary = Object.freeze({
  id: "0011_bound_secret_envelopes",
  description: "Bind every encrypted secret to its persisted owner and purpose",
  checksum: "9679423e95636b7cdd958c0e9ab2c8ccebc0e2ce8e573ee8ac6f7a8fc1ca356b",
});
