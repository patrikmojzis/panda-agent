import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_CHANNEL_RECEIPT_OWNERSHIP: PostgresMigrationSummary = Object.freeze({
  id: "0020_channel_receipt_ownership",
  description: "Fence channel receipts and preserve interrupted dispatch as unknown",
  checksum: "d9b996074245860cb70d6978fa4d8bae326e2704eda0f03aac0f79eefabe5616",
});
