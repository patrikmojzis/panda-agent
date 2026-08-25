import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {ensureReadonlySessionQuerySchema} from "../../../domain/threads/runtime/postgres-readonly.js";
import {PANDA_LEGACY_SCHEMA_RECONCILIATION} from "../../../integrations/postgres/schema-versions/0008-legacy-schema-reconciliation.js";

/**
 * Normalizes schema objects left by pre-ledger installations. Retired memory
 * tables are archived outside Panda's live schemas so their data is preserved.
 */
export const LEGACY_SCHEMA_RECONCILIATION_MIGRATION: PostgresMigration = {
  ...PANDA_LEGACY_SCHEMA_RECONCILIATION,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE SCHEMA IF NOT EXISTS "panda_legacy";

      DROP VIEW IF EXISTS "session"."agent_diary";
      DROP VIEW IF EXISTS "session"."agent_documents";
      DROP VIEW IF EXISTS "session"."sidecars";

      DO $$
      DECLARE
        relation_name TEXT;
      BEGIN
        FOREACH relation_name IN ARRAY ARRAY['agent_diary', 'agent_documents', 'sidecars']
        LOOP
          IF to_regclass(format('runtime.%I', relation_name)) IS NOT NULL THEN
            IF to_regclass(format('panda_legacy.%I', relation_name)) IS NOT NULL THEN
              RAISE EXCEPTION 'Cannot archive runtime.%: panda_legacy.% already exists',
                relation_name,
                relation_name;
            END IF;
            EXECUTE format('ALTER TABLE runtime.%I SET SCHEMA panda_legacy', relation_name);
          END IF;
        END LOOP;
      END
      $$;

      DO $$
      BEGIN
        IF to_regclass('runtime.session_routes_rebuild_id_seq') IS NOT NULL THEN
          IF to_regclass('runtime.session_routes_id_seq') IS NOT NULL THEN
            RAISE EXCEPTION 'Both legacy and current session route sequences exist';
          END IF;
          ALTER SEQUENCE "runtime"."session_routes_rebuild_id_seq"
          RENAME TO "session_routes_id_seq";
        END IF;
      END
      $$;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'runtime.session_routes'::regclass
            AND conname = 'session_routes_rebuild_pkey'
        ) THEN
          IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'runtime.session_routes'::regclass
              AND conname = 'session_routes_pkey'
          ) THEN
            ALTER TABLE "runtime"."session_routes"
            DROP CONSTRAINT "session_routes_rebuild_pkey";
          ELSE
            ALTER TABLE "runtime"."session_routes"
            RENAME CONSTRAINT "session_routes_rebuild_pkey" TO "session_routes_pkey";
          END IF;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'runtime.threads'::regclass
            AND conname = 'threads_session_id_fkey'
        ) THEN
          IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'runtime.threads'::regclass
              AND conname = 'runtime_threads_session_fk'
          ) THEN
            ALTER TABLE "runtime"."threads"
            DROP CONSTRAINT "threads_session_id_fkey";
          ELSE
            ALTER TABLE "runtime"."threads"
            RENAME CONSTRAINT "threads_session_id_fkey" TO "runtime_threads_session_fk";
          END IF;
        END IF;
      END
      $$;

      ALTER TABLE "runtime"."session_heartbeats"
      ALTER COLUMN "every_minutes" SET DEFAULT 60,
      ALTER COLUMN "next_fire_at" SET DEFAULT NOW() + INTERVAL '60 minutes';
    `);

    await ensureReadonlySessionQuerySchema({queryable});
  },
};
