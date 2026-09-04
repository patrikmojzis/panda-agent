import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_SESSION_COMPACTION_REQUESTS} from "../../../integrations/postgres/schema-versions/0018-session-compaction-requests.js";
import {ensureSessionCompactionSchema} from "../../../domain/sessions/compaction-postgres-schema.js";

export const SESSION_COMPACTION_REQUESTS_MIGRATION: PostgresMigration = {
  ...PANDA_SESSION_COMPACTION_REQUESTS,
  apply: async ({queryable}) => ensureSessionCompactionSchema(queryable),
};
