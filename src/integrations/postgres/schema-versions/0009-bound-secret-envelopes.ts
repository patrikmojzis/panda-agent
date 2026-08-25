import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_BOUND_SECRET_ENVELOPES: PostgresMigrationSummary = Object.freeze({
  id: "0009_bound_secret_envelopes",
  description: "Bind every encrypted secret to its persisted owner and purpose",
  checksum: "82c31fd22e7d508909656a7cc15ba6c6d4e3af7ea3c0cc1532f798a0c65641dd",
});
