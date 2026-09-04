import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_GATEWAY_INPUT_RECEIPTS: PostgresMigrationSummary = Object.freeze({
  id: "0024_gateway_input_receipts",
  description: "Add stable Gateway input receipts without replaying legacy deliveries",
  checksum: "f1efd5e317d6163e38d3ca02c0ed62c808a43e449f43f0bbb07d8cfdc55ec836",
});
