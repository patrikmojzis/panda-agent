import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_LEGACY_INPUT_BACKLOG_QUARANTINE} from "../../../integrations/postgres/schema-versions/0009-legacy-input-backlog-quarantine.js";

/**
 * Prevents the 0006 wake-generation cutover from reviving legacy inter-agent
 * inputs. Original rows remain available in panda_legacy for incident review.
 */
export const LEGACY_INPUT_BACKLOG_QUARANTINE_MIGRATION: PostgresMigration = {
  ...PANDA_LEGACY_INPUT_BACKLOG_QUARANTINE,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE SCHEMA IF NOT EXISTS "panda_legacy";

      CREATE TABLE "panda_legacy"."thread_input_cutover_quarantine" (
        LIKE "runtime"."inputs",
        "session_id" TEXT NOT NULL,
        "resolution" TEXT NOT NULL,
        "quarantined_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        CHECK ("resolution" IN ('pending_quarantined', 'replayed_observed'))
      );

      WITH cutoff AS MATERIALIZED (
        SELECT "applied_at"
        FROM "runtime"."schema_migrations"
        WHERE "migration_id" = '0006_thread_input_cutoffs'
      ), candidates AS MATERIALIZED (
        SELECT
          input.*,
          thread."session_id",
          CASE
            WHEN input."applied_at" IS NULL THEN 'pending_quarantined'
            ELSE 'replayed_observed'
          END AS "resolution"
        FROM "runtime"."inputs" AS input
        INNER JOIN "runtime"."threads" AS thread
          ON thread."id" = input."thread_id"
        INNER JOIN "runtime"."agent_sessions" AS session
          ON session."id" = thread."session_id"
         AND session."current_thread_id" = thread."id"
        CROSS JOIN cutoff
        WHERE input."created_at" < cutoff."applied_at"
          AND input."delivery_mode" = 'wake'
          AND input."source" IN ('subagent', 'a2a', 'worker')
          AND (
            (
              input."applied_at" IS NULL
              AND input."discarded_at" IS NULL
            )
            OR input."applied_at" >= cutoff."applied_at"
          )
        FOR UPDATE OF input
      ), archived AS (
        INSERT INTO "panda_legacy"."thread_input_cutover_quarantine" (
          "id",
          "thread_id",
          "input_order",
          "delivery_mode",
          "source",
          "channel_id",
          "external_message_id",
          "actor_id",
          "identity_id",
          "created_at",
          "applied_at",
          "metadata",
          "message",
          "connector_key",
          "applied_run_id",
          "discarded_at",
          "session_id",
          "resolution"
        )
        SELECT
          "id",
          "thread_id",
          "input_order",
          "delivery_mode",
          "source",
          "channel_id",
          "external_message_id",
          "actor_id",
          "identity_id",
          "created_at",
          "applied_at",
          "metadata",
          "message",
          "connector_key",
          "applied_run_id",
          "discarded_at",
          "session_id",
          "resolution"
        FROM candidates
        ORDER BY "input_order"
        RETURNING "id", "session_id", "resolution"
      ), discarded AS (
        UPDATE "runtime"."inputs" AS input
        SET "discarded_at" = NOW(),
            "metadata" = NULL,
            "message" = NULL
        FROM archived
        WHERE archived."id" = input."id"
          AND archived."resolution" = 'pending_quarantined'
          AND input."applied_at" IS NULL
          AND input."discarded_at" IS NULL
        RETURNING input."id"
      ), affected_sessions AS (
        SELECT DISTINCT "session_id"
        FROM archived
        WHERE "resolution" = 'pending_quarantined'
      ), disarmed AS (
        UPDATE "runtime"."session_runtime_config" AS config
        SET "pending_wake_at" = NULL,
            "updated_at" = NOW()
        FROM affected_sessions, cutoff
        WHERE config."session_id" = affected_sessions."session_id"
          AND config."pending_wake_at" = cutoff."applied_at"
          AND NOT EXISTS (
            SELECT 1
            FROM "runtime"."agent_sessions" AS session
            INNER JOIN "runtime"."threads" AS thread
              ON thread."id" = session."current_thread_id"
             AND thread."session_id" = session."id"
            INNER JOIN "runtime"."inputs" AS remaining
              ON remaining."thread_id" = thread."id"
            WHERE session."id" = config."session_id"
              AND remaining."applied_at" IS NULL
              AND remaining."discarded_at" IS NULL
              AND remaining."delivery_mode" = 'wake'
              AND NOT EXISTS (
                SELECT 1
                FROM archived
                WHERE archived."id" = remaining."id"
                  AND archived."resolution" = 'pending_quarantined'
              )
          )
        RETURNING config."session_id"
      )
      SELECT
        (SELECT COUNT(*) FROM archived) AS "archived_count",
        (SELECT COUNT(*) FROM discarded) AS "discarded_count",
        (SELECT COUNT(*) FROM disarmed) AS "disarmed_count";

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "panda_legacy"."thread_input_cutover_quarantine" AS archived
          INNER JOIN "runtime"."inputs" AS input ON input."id" = archived."id"
          WHERE archived."resolution" = 'pending_quarantined'
            AND (
              input."discarded_at" IS NULL
              OR input."metadata" IS NOT NULL
              OR input."message" IS NOT NULL
            )
        ) THEN
          RAISE EXCEPTION 'Legacy input quarantine left pending rows runnable';
        END IF;
      END
      $$;
    `);
  },
};
