import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_EMAIL_RECIPIENT_ALLOW_RULES} from "../../../integrations/postgres/schema-versions/0014-email-recipient-allow-rules.js";

export const EMAIL_RECIPIENT_ALLOW_RULES_MIGRATION: PostgresMigration = {
  ...PANDA_EMAIL_RECIPIENT_ALLOW_RULES,
  apply: async ({queryable}) => {
    await queryable.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "runtime"."email_allowed_recipients"
          WHERE length(btrim("address")) = 0
             OR "address" <> btrim("address")
             OR "address" <> lower("address")
             OR "address" !~ '^[^@[:space:]<>]+@[^@[:space:]<>]+\\.[^@[:space:]<>]+$'
        ) THEN
          RAISE EXCEPTION 'Email recipient allow-rule migration found a legacy address outside the canonical exact-address contract.';
        END IF;
      END
      $$;

      DROP VIEW "session"."email_allowed_recipients";

      ALTER TABLE "runtime"."email_allowed_recipients"
        RENAME TO "email_recipient_allow_rules";
      ALTER TABLE "runtime"."email_recipient_allow_rules"
        RENAME COLUMN "address" TO "rule_value";
      ALTER TABLE "runtime"."email_recipient_allow_rules"
        ADD COLUMN "rule_kind" TEXT;
      UPDATE "runtime"."email_recipient_allow_rules"
        SET "rule_kind" = 'address';
      ALTER TABLE "runtime"."email_recipient_allow_rules"
        ALTER COLUMN "rule_kind" SET NOT NULL;

      ALTER TABLE "runtime"."email_recipient_allow_rules"
        RENAME CONSTRAINT "email_allowed_recipients_pkey"
        TO "email_recipient_allow_rules_pkey";
      ALTER TABLE "runtime"."email_recipient_allow_rules"
        RENAME CONSTRAINT "runtime_email_allowed_account_fk"
        TO "runtime_email_recipient_allow_rules_account_fk";

      DROP INDEX "runtime"."runtime_email_allowed_key_idx";
      CREATE UNIQUE INDEX "runtime_email_recipient_allow_rules_key_idx"
        ON "runtime"."email_recipient_allow_rules"
          ("agent_key", "account_key", "rule_kind", "rule_value");

      ALTER TABLE "runtime"."email_recipient_allow_rules"
        ADD CONSTRAINT "runtime_email_recipient_allow_rules_kind_check"
        CHECK ("rule_kind" IN ('address', 'domain'));
      ALTER TABLE "runtime"."email_recipient_allow_rules"
        ADD CONSTRAINT "runtime_email_recipient_allow_rules_value_check"
        CHECK (length(btrim("rule_value")) > 0 AND "rule_value" = btrim("rule_value"));

      CREATE VIEW "session"."email_recipient_allow_rules"
      WITH (security_barrier = true) AS
      SELECT DISTINCT
        recipient_rule.id,
        recipient_rule.agent_key,
        recipient_rule.account_key,
        recipient_rule.rule_kind,
        recipient_rule.rule_value,
        recipient_rule.created_at
      FROM "runtime"."email_recipient_allow_rules" AS recipient_rule
      INNER JOIN (
        SELECT id, agent_key, kind
        FROM "runtime"."agent_sessions"
        WHERE id = current_setting('runtime.session_id', true)
        LIMIT 1
      ) AS active_session
        ON active_session.agent_key = recipient_rule.agent_key
      LEFT JOIN "runtime"."email_routes" AS visible_route
        ON visible_route.agent_key = recipient_rule.agent_key
       AND visible_route.account_key = recipient_rule.account_key
       AND visible_route.session_id = active_session.id
      LEFT JOIN "runtime"."email_routes" AS account_route
        ON account_route.agent_key = recipient_rule.agent_key
       AND account_route.account_key = recipient_rule.account_key
       AND account_route.mailbox IS NULL
      WHERE visible_route.id IS NOT NULL
        OR (active_session.kind = 'main' AND account_route.id IS NULL);
    `);
  },
};
