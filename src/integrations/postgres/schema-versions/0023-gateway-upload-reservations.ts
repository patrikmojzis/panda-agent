import type {PostgresMigrationSummary} from "../../../lib/postgres-migrations.js";

export const PANDA_GATEWAY_UPLOAD_RESERVATIONS: PostgresMigrationSummary = Object.freeze({
  id: "0023_gateway_upload_reservations",
  description: "Reserve bounded Gateway upload admission before streaming bytes",
  checksum: "b5148533aa9fe7d80d38fdb4ab6165a2a5fada124639dfca800cd4b864e7a8d2",
});
