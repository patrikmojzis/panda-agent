import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_SCHEDULED_COMMANDS} from "../../../integrations/postgres/schema-versions/0013-scheduled-commands.js";

export const SCHEDULED_COMMANDS_MIGRATION: PostgresMigration = {
  ...PANDA_SCHEDULED_COMMANDS,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE TABLE "runtime"."scheduled_commands" (
        "id" UUID PRIMARY KEY,
        "session_id" TEXT NOT NULL REFERENCES "runtime"."agent_sessions"("id") ON DELETE CASCADE,
        "created_by_identity_id" TEXT REFERENCES "runtime"."identities"("id") ON DELETE SET NULL,
        "created_from_message_id" UUID REFERENCES "runtime"."messages"("id") ON DELETE SET NULL,
        "active_version" INTEGER NOT NULL CHECK ("active_version" > 0),
        "next_fire_at" TIMESTAMPTZ,
        "blocked_at" TIMESTAMPTZ,
        "blocked_reason" TEXT,
        "consecutive_failures" INTEGER NOT NULL DEFAULT 0 CHECK ("consecutive_failures" >= 0),
        "last_failure_code" TEXT,
        "last_notified_failure_code" TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("session_id", "id")
      );

      CREATE TABLE "runtime"."scheduled_command_versions" (
        "command_id" UUID NOT NULL,
        "session_id" TEXT NOT NULL,
        "version" INTEGER NOT NULL CHECK ("version" > 0),
        "title" TEXT NOT NULL CHECK (length(btrim("title")) > 0 AND length("title") <= 200),
        "command_text" TEXT NOT NULL CHECK (length(btrim("command_text")) > 0 AND length("command_text") <= 64000),
        "cwd" TEXT CHECK ("cwd" IS NULL OR (length(btrim("cwd")) > 0 AND length("cwd") <= 2048)),
        "cron_expr" TEXT NOT NULL,
        "timezone" TEXT NOT NULL,
        "credential_names" TEXT[] NOT NULL DEFAULT '{}',
        "timeout_ms" INTEGER NOT NULL CHECK ("timeout_ms" BETWEEN 1000 AND 21600000),
        "enabled" BOOLEAN NOT NULL,
        "key_id" TEXT NOT NULL,
        "integrity_tag" TEXT NOT NULL CHECK ("integrity_tag" ~ '^[a-f0-9]{64}$'),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("command_id", "version"),
        FOREIGN KEY ("session_id", "command_id")
          REFERENCES "runtime"."scheduled_commands"("session_id", "id")
          ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      );

      ALTER TABLE "runtime"."scheduled_commands"
        ADD CONSTRAINT "runtime_scheduled_commands_active_version_fk"
        FOREIGN KEY ("id", "active_version")
        REFERENCES "runtime"."scheduled_command_versions"("command_id", "version")
        DEFERRABLE INITIALLY DEFERRED;

      CREATE TABLE "runtime"."scheduled_command_runs" (
        "id" UUID PRIMARY KEY,
        "command_id" UUID NOT NULL,
        "session_id" TEXT NOT NULL,
        "version" INTEGER NOT NULL,
        "trigger" TEXT NOT NULL CHECK ("trigger" IN ('schedule', 'manual')),
        "scheduled_for" TIMESTAMPTZ NOT NULL,
        "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'claimed', 'running', 'succeeded', 'failed', 'cancelled')),
        "claim_token" UUID,
        "claimed_at" TIMESTAMPTZ,
        "claimed_by" TEXT,
        "claim_expires_at" TIMESTAMPTZ,
        "resolved_environment_id" TEXT,
        "resolved_cwd" TEXT,
        "exit_code" INTEGER,
        "timed_out" BOOLEAN,
        "stdout_preview" TEXT,
        "stderr_preview" TEXT,
        "stdout_truncated" BOOLEAN,
        "stderr_truncated" BOOLEAN,
        "failure_code" TEXT,
        "error" TEXT,
        "notification_kind" TEXT CHECK ("notification_kind" IS NULL OR "notification_kind" IN ('failure', 'recovery')),
        "notified_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "started_at" TIMESTAMPTZ,
        "finished_at" TIMESTAMPTZ,
        FOREIGN KEY ("command_id", "version")
          REFERENCES "runtime"."scheduled_command_versions"("command_id", "version") ON DELETE CASCADE,
        FOREIGN KEY ("session_id", "command_id")
          REFERENCES "runtime"."scheduled_commands"("session_id", "id") ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX "runtime_scheduled_command_runs_one_active_idx"
        ON "runtime"."scheduled_command_runs" ("command_id")
        WHERE "status" IN ('pending', 'claimed', 'running')
           OR ("notification_kind" IS NOT NULL AND "notified_at" IS NULL);
      CREATE INDEX "runtime_scheduled_commands_due_idx"
        ON "runtime"."scheduled_commands" ("next_fire_at", "id")
        WHERE "next_fire_at" IS NOT NULL AND "blocked_at" IS NULL;
      CREATE INDEX "runtime_scheduled_commands_session_idx"
        ON "runtime"."scheduled_commands" ("session_id", "updated_at" DESC, "id");
      CREATE INDEX "runtime_scheduled_command_runs_claim_idx"
        ON "runtime"."scheduled_command_runs" ("claim_expires_at", "scheduled_for", "id")
        WHERE "status" IN ('pending', 'claimed', 'running')
           OR ("notification_kind" IS NOT NULL AND "notified_at" IS NULL);
      CREATE INDEX "runtime_scheduled_command_runs_history_idx"
        ON "runtime"."scheduled_command_runs" ("command_id", "created_at" DESC, "id");

      CREATE VIEW "session"."scheduled_commands"
      WITH (security_barrier = true) AS
      SELECT
        command_row.id,
        command_row.session_id,
        command_row.created_by_identity_id,
        creator.handle AS created_by_identity_handle,
        command_row.created_from_message_id,
        version_row.version,
        version_row.title,
        version_row.command_text,
        version_row.cwd,
        version_row.cron_expr,
        version_row.timezone,
        version_row.credential_names,
        version_row.timeout_ms,
        version_row.enabled,
        command_row.next_fire_at,
        command_row.blocked_at,
        command_row.blocked_reason,
        command_row.consecutive_failures,
        command_row.last_failure_code,
        command_row.created_at,
        command_row.updated_at
      FROM "runtime"."scheduled_commands" AS command_row
      INNER JOIN "runtime"."scheduled_command_versions" AS version_row
        ON version_row.command_id = command_row.id
       AND version_row.version = command_row.active_version
      LEFT JOIN "runtime"."identities" AS creator ON creator.id = command_row.created_by_identity_id
      WHERE command_row.session_id = current_setting('runtime.session_id', true);

      CREATE VIEW "session"."scheduled_command_runs"
      WITH (security_barrier = true) AS
      SELECT
        run.id,
        run.command_id,
        run.session_id,
        run.version,
        run.trigger,
        run.scheduled_for,
        run.status,
        run.resolved_environment_id,
        run.resolved_cwd,
        run.exit_code,
        run.timed_out,
        run.stdout_preview,
        run.stderr_preview,
        run.stdout_truncated,
        run.stderr_truncated,
        run.failure_code,
        run.error,
        run.notification_kind,
        run.notified_at,
        run.created_at,
        run.started_at,
        run.finished_at
      FROM "runtime"."scheduled_command_runs" AS run
      WHERE run.session_id = current_setting('runtime.session_id', true);
    `);
  },
};
