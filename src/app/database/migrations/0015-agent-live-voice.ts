import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_AGENT_LIVE_VOICE} from "../../../integrations/postgres/schema-versions/0015-agent-live-voice.js";

export const AGENT_LIVE_VOICE_MIGRATION: PostgresMigration = {
  ...PANDA_AGENT_LIVE_VOICE,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."agents"
        ADD COLUMN "live_voice" TEXT NOT NULL DEFAULT 'cove';
      ALTER TABLE "runtime"."agents"
        ADD CONSTRAINT "runtime_agents_live_voice_check"
        CHECK (
          "live_voice" = btrim("live_voice")
          AND length("live_voice") BETWEEN 1 AND 64
        );

      ALTER TABLE "runtime"."live_voice_sessions"
        ADD COLUMN "voice" TEXT;
      ALTER TABLE "runtime"."live_voice_sessions"
        ADD CONSTRAINT "runtime_live_voice_sessions_voice_check"
        CHECK (
          "voice" IS NULL
          OR (
            "voice" = btrim("voice")
            AND length("voice") BETWEEN 1 AND 64
          )
        );
    `);
  },
};
