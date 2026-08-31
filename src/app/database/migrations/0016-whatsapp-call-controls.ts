import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_WHATSAPP_CALL_CONTROLS} from "../../../integrations/postgres/schema-versions/0016-whatsapp-call-controls.js";

export const WHATSAPP_CALL_CONTROLS_MIGRATION: PostgresMigration = {
  ...PANDA_WHATSAPP_CALL_CONTROLS,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE TABLE "runtime"."whatsapp_call_controls" (
        "id" UUID PRIMARY KEY,
        "connector_key" TEXT NOT NULL,
        "operation" TEXT NOT NULL CHECK ("operation" IN ('send', 'hangup')),
        "session_id" TEXT NOT NULL,
        "agent_key" TEXT NOT NULL,
        "call_id" TEXT NOT NULL CHECK (length("call_id") BETWEEN 1 AND 256),
        "text" TEXT,
        "mode" TEXT CHECK ("mode" IS NULL OR "mode" IN ('progress', 'final')),
        "voice_turn_id" UUID,
        "idempotency_key" TEXT,
        "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'running', 'completed', 'failed')),
        "result" JSONB,
        "error" TEXT,
        "completed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "runtime_whatsapp_call_controls_payload_check" CHECK (
          ("operation" = 'send' AND "text" IS NOT NULL AND "mode" IS NOT NULL)
          OR ("operation" = 'hangup' AND "text" IS NULL AND "mode" IS NULL)
        )
      );
      CREATE INDEX "runtime_whatsapp_call_controls_pending_idx"
        ON "runtime"."whatsapp_call_controls" ("connector_key", "status", "created_at", "id");
      CREATE UNIQUE INDEX "runtime_whatsapp_call_controls_idempotency_idx"
        ON "runtime"."whatsapp_call_controls" ("idempotency_key");
      ALTER TABLE "runtime"."live_voice_turns"
        ADD COLUMN "transport_authorization" JSONB;
    `);
  },
};
