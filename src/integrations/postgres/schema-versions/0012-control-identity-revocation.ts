import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_CONTROL_IDENTITY_REVOCATION: PostgresMigrationSummary = Object.freeze({
  id: "0012_control_identity_revocation",
  description: "Revoke Control access retained by deleted identities",
  checksum: "e6480fbf2d0b1039878435c26567a48affe89c1a2af74f856088579573fb1d0a",
});
