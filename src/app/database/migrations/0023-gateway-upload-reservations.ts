import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_GATEWAY_UPLOAD_RESERVATIONS} from "../../../integrations/postgres/schema-versions/0023-gateway-upload-reservations.js";

export const GATEWAY_UPLOAD_RESERVATIONS_MIGRATION: PostgresMigration = {
  ...PANDA_GATEWAY_UPLOAD_RESERVATIONS,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE TABLE "runtime"."gateway_upload_reservations" (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES "runtime"."gateway_sources"(source_id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        directory TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'receiving',
        is_retry BOOLEAN NOT NULL,
        reserved_bytes BIGINT NOT NULL,
        quota_window_start TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX runtime_gateway_upload_reservations_expires_idx
        ON "runtime"."gateway_upload_reservations" (status, expires_at);
    `);
  },
};
