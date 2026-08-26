import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_SESSION_ARCHIVE} from "../../../integrations/postgres/schema-versions/0009-session-archive.js";

/** Adds the durable archive authority and explicit session ownership for queued effects. */
export const SESSION_ARCHIVE_MIGRATION: PostgresMigration = {
  ...PANDA_SESSION_ARCHIVE,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."agent_sessions"
      ADD COLUMN "archived_at" TIMESTAMPTZ;

      ALTER TABLE "runtime"."agent_sessions"
      ADD CONSTRAINT "runtime_agent_sessions_archive_kind_check"
      CHECK ("archived_at" IS NULL OR "kind" = 'branch');

      CREATE INDEX "runtime_agent_sessions_active_agent_idx"
      ON "runtime"."agent_sessions" ("agent_key", "created_at" DESC, "id")
      WHERE "archived_at" IS NULL;

      CREATE INDEX "runtime_agent_sessions_archived_agent_idx"
      ON "runtime"."agent_sessions" ("agent_key", "archived_at" DESC, "id")
      WHERE "archived_at" IS NOT NULL;

      ALTER TABLE "runtime"."outbound_deliveries"
      ADD COLUMN "session_id" TEXT;

      UPDATE "runtime"."outbound_deliveries" AS delivery
      SET "session_id" = thread."session_id"
      FROM "runtime"."threads" AS thread
      WHERE thread."id" = delivery."thread_id";

      ALTER TABLE "runtime"."outbound_deliveries"
      ADD CONSTRAINT "runtime_outbound_deliveries_session_fk"
      FOREIGN KEY ("session_id")
      REFERENCES "runtime"."agent_sessions"("id")
      ON DELETE SET NULL;

      ALTER TABLE "runtime"."outbound_deliveries"
      ADD CONSTRAINT "runtime_outbound_deliveries_thread_requires_session_check"
      CHECK ("thread_id" IS NULL OR "session_id" IS NOT NULL);

      ALTER TABLE "runtime"."outbound_deliveries"
      ADD CONSTRAINT "runtime_outbound_deliveries_session_thread_fk"
      FOREIGN KEY ("session_id", "thread_id")
      REFERENCES "runtime"."threads"("session_id", "id")
      ON DELETE SET NULL;

      CREATE INDEX "runtime_outbound_deliveries_session_pending_idx"
      ON "runtime"."outbound_deliveries" ("session_id", "status", "created_at", "id")
      WHERE "session_id" IS NOT NULL;

      ALTER TABLE "runtime"."channel_actions"
      ADD COLUMN "session_id" TEXT,
      ADD COLUMN "thread_id" TEXT;

      ALTER TABLE "runtime"."channel_actions"
      ADD CONSTRAINT "runtime_channel_actions_session_fk"
      FOREIGN KEY ("session_id")
      REFERENCES "runtime"."agent_sessions"("id")
      ON DELETE SET NULL;

      ALTER TABLE "runtime"."channel_actions"
      ADD CONSTRAINT "runtime_channel_actions_thread_fk"
      FOREIGN KEY ("thread_id")
      REFERENCES "runtime"."threads"("id")
      ON DELETE SET NULL;

      ALTER TABLE "runtime"."channel_actions"
      ADD CONSTRAINT "runtime_channel_actions_thread_requires_session_check"
      CHECK ("thread_id" IS NULL OR "session_id" IS NOT NULL);

      ALTER TABLE "runtime"."channel_actions"
      ADD CONSTRAINT "runtime_channel_actions_session_thread_fk"
      FOREIGN KEY ("session_id", "thread_id")
      REFERENCES "runtime"."threads"("session_id", "id")
      ON DELETE SET NULL;

      CREATE INDEX "runtime_channel_actions_session_pending_idx"
      ON "runtime"."channel_actions" ("session_id", "status", "created_at", "id")
      WHERE "session_id" IS NOT NULL;
    `);
  },
};
