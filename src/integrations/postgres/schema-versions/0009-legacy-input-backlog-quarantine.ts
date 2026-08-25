import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_LEGACY_INPUT_BACKLOG_QUARANTINE: PostgresMigrationSummary = Object.freeze({
  id: "0009_legacy_input_backlog_quarantine",
  description: "Quarantine legacy inter-agent wake backlog",
  checksum: "d873bd596920f5035fb60816295f10cbbb9ca1b97341c27842db90ba26d89bd4",
});
