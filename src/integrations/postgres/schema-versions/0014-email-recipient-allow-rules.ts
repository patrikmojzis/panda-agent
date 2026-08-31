import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_EMAIL_RECIPIENT_ALLOW_RULES: PostgresMigrationSummary = Object.freeze({
  id: "0014_email_recipient_allow_rules",
  description: "Add typed email recipient address and domain allow rules",
  checksum: "2341f71e8ddd2985c70b5f3e25573da83f667afab1feac97d985367892c7cc64",
});
