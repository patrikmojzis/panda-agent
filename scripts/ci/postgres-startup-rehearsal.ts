#!/usr/bin/env tsx
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {READONLY_SESSION_VIEW_BASENAMES} from "../../src/domain/threads/runtime/index.js";
import {createPandaSchemaMigrator, PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {runPandaDatabaseIntegrityChecks} from "../../src/app/database/integrity-catalog.js";
import {
  PANDA_EXPECTED_COLUMNS,
  PANDA_EXPECTED_CONSTRAINTS,
  PANDA_EXPECTED_RELATIONS,
} from "../../src/app/database/schema-object-manifest.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {
  createPostgresReadonlyQueryCommand,
  POSTGRES_READONLY_QUERY_EXAMPLES,
} from "../../src/integrations/postgres/readonly-query-command.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(repoRoot, "scripts/ci/postgres-fixtures");
const preLedgerBaseFixture = path.join(fixtureDir, "pre-ledger-base.sql");

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error("Postgres startup rehearsal requires TEST_DATABASE_URL.");
  }
  return value;
}

async function prepareLegacyFixtureBase(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  // This checked-in SQL is an immutable historical shape. Never manufacture
  // an upgrade fixture with today's installers: that only proves code agrees
  // with itself and hides real pre-ledger regressions.
  await applyFixture(pool, preLedgerBaseFixture);
}

async function applyFixture(pool: ReturnType<typeof createPostgresPool>, fixturePath: string): Promise<void> {
  const sql = await readFile(fixturePath, "utf8");
  await pool.query(sql);
}

async function listFixtures(): Promise<string[]> {
  const entries = await readdir(fixtureDir, {withFileTypes: true});
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("legacy-") && entry.name.endsWith(".sql"))
    .map((entry) => path.join(fixtureDir, entry.name))
    .toSorted();
}

async function assertRegclasses(pool: ReturnType<typeof createPostgresPool>, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const result = await pool.query("SELECT to_regclass($1) AS relation", [name]);
    if (!result.rows[0]?.relation) {
      throw new Error(`Expected relation ${name} to exist after startup rehearsal.`);
    }
  }
}

async function assertLegacyThreadContextColumnDropped(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  const result = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'threads'
      AND column_name = 'context'
    LIMIT 1
  `);
  if (result.rows.length > 0) {
    throw new Error("Expected legacy runtime.threads.context column to be dropped after startup rehearsal.");
  }
}

async function assertCoreRelations(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  await assertRegclasses(pool, [
    "runtime.agents",
    "runtime.identities",
    "runtime.agent_sessions",
    "runtime.threads",
    "runtime.messages",
    "runtime.tool_jobs",
    "runtime.session_routes",
    "runtime.credentials",
    ...READONLY_SESSION_VIEW_BASENAMES.map((name) => `session.${name}`),
  ]);
}

async function assertBaselineCutover(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  const expectedIndexes = new Map([
    ["runtime_agent_pairings_agent_created_idx", "(agent_key, created_at, identity_id)"],
    ["runtime_identity_bindings_identity_created_idx", "(identity_id, created_at, id)"],
    ["runtime_session_routes_latest_identity_idx", "(session_id, identity_id, captured_at_ms DESC, updated_at DESC, id DESC)"],
  ]);
  const indexes = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'runtime'
      AND indexname = ANY($1::TEXT[])
  `, [[...expectedIndexes.keys()]]);
  for (const [name, columns] of expectedIndexes) {
    const row = indexes.rows.find((candidate) => candidate.indexname === name);
    if (!row || !String(row.indexdef).includes(columns)) {
      throw new Error(`Expected ${name} on ${columns}.`);
    }
  }
  const removedRelations = await pool.query(`
    SELECT to_regclass('runtime.runtime_session_routes_lookup_idx') AS legacy_route_index,
           to_regclass('runtime.thread_runtime_migrations') AS thread_ledger,
           to_regclass('runtime.whatsapp_migrations') AS whatsapp_ledger
  `);
  if (Object.values(removedRelations.rows[0] ?? {}).some((value) => value !== null)) {
    throw new Error("Expected superseded indexes and local migration ledgers to be removed.");
  }

  const migratedInput = await pool.query(`
    SELECT input.message,
           input.metadata,
           input.applied_run_id,
           message.id AS message_id
    FROM runtime.inputs AS input
    LEFT JOIN runtime.messages AS message ON message.input_id = input.id
    WHERE input.id = '00000000-0000-4000-8000-000000000010'
  `);
  if (migratedInput.rows.length > 0) {
    const row = migratedInput.rows[0];
    if (row?.message !== null || row?.metadata !== null || !row?.message_id) {
      throw new Error("Expected legacy applied input payload to be linked once and scrubbed.");
    }
  }

  const migratedCheckpoint = await pool.query(`
    SELECT compacted_through_sequence,
           metadata,
           metadata ? 'compactedUpToSequence' AS has_legacy_cutoff
    FROM runtime.messages
    WHERE id = '00000000-0000-4000-8000-000000000013'
  `);
  if (migratedCheckpoint.rows.length > 0) {
    const row = migratedCheckpoint.rows[0];
    if (
      Number(row?.compacted_through_sequence) !== 1
      || row?.has_legacy_cutoff !== false
      || row?.metadata?.trigger !== "auto"
      || row?.metadata?.preservedTailUserTurns !== 3
    ) {
      throw new Error("Expected legacy compaction cutoff to move into the typed column exactly once.");
    }
  }

  const migratedRequests = await pool.query(`
    SELECT id, status, payload, ordering_key, error, claim_token, claim_expires_at, finished_at
    FROM runtime.runtime_requests
    WHERE id IN (
      '00000000-0000-4000-8000-000000000023',
      '00000000-0000-4000-8000-000000000024',
      '00000000-0000-4000-8000-000000000025'
    )
    ORDER BY id
  `);
  if (migratedRequests.rows.length > 0) {
    const branch = migratedRequests.rows.find((row) => row.id === "00000000-0000-4000-8000-000000000023");
    const voice = migratedRequests.rows.find((row) => row.id === "00000000-0000-4000-8000-000000000024");
    const interrupted = migratedRequests.rows.find((row) => row.id === "00000000-0000-4000-8000-000000000025");
    const branchPayload = branch?.payload as Record<string, unknown> | undefined;
    const voicePayload = voice?.payload as Record<string, unknown> | undefined;
    if (
      branchPayload?.sessionId !== "branch-session:00000000-0000-4000-8000-000000000023"
      || branchPayload.threadId !== "branch-thread:00000000-0000-4000-8000-000000000023"
      || typeof branch?.ordering_key !== "string"
      || !branch.ordering_key.startsWith("v1:")
    ) {
      throw new Error("Expected legacy branch request to receive deterministic target ids and an ordering key.");
    }
    if (
      voicePayload?.sessionId !== "ci-legacy-session"
      || typeof voice?.ordering_key !== "string"
      || !voice.ordering_key.startsWith("v1:")
    ) {
      throw new Error("Expected legacy live-voice request to inherit its turn session and ordering key.");
    }
    if (
      interrupted?.status !== "failed"
      || interrupted.error !== "Legacy running runtime request was interrupted by schema migration and cannot be replayed safely."
      || interrupted.claim_token !== null
      || interrupted.claim_expires_at !== null
      || !interrupted.finished_at
      || typeof interrupted.ordering_key !== "string"
      || !interrupted.ordering_key.startsWith("v1:")
    ) {
      throw new Error("Expected legacy running requests to fail closed instead of replaying an uncorrelated effect.");
    }
  }
}

async function assertReadonlyExamplesExecute(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  const command = createPostgresReadonlyQueryCommand({pool});
  const scope = {
    agentKey: "panda",
    sessionId: "startup-rehearsal",
    skillPolicy: {mode: "all_agent" as const},
  };
  const schemaHelp = await command.execute({
    command: "postgres.readonly.query",
    input: {schemaHelp: true},
    scope,
  });
  const messagesView = (schemaHelp.output.views as Array<{
    name: string;
    columns: Array<{name: string}>;
  }>).find((view) => view.name === "session.messages");
  if (!messagesView?.columns.some((column) => column.name === "text")) {
    throw new Error("Expected live readonly schema help to expose session.messages.text.");
  }

  for (const example of POSTGRES_READONLY_QUERY_EXAMPLES) {
    await command.execute({
      command: "postgres.readonly.query",
      input: {sql: example.sql},
      scope,
    });
  }
}

async function assertSchemaObjectManifestExact(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  const relations = await pool.query(`
    SELECT namespace.nspname AS schema_name,
           relation.relname AS object_name,
           relation.relkind::TEXT AS object_kind,
           MD5(CASE relation.relkind
             WHEN 'i' THEN pg_get_indexdef(relation.oid)
             WHEN 'v' THEN pg_get_viewdef(relation.oid, TRUE)
             WHEN 'm' THEN pg_get_viewdef(relation.oid, TRUE)
             WHEN 'S' THEN CONCAT_WS('|',
               format_type(sequence.seqtypid, NULL),
               sequence.seqstart::TEXT,
               sequence.seqincrement::TEXT,
               sequence.seqmax::TEXT,
               sequence.seqmin::TEXT,
               sequence.seqcache::TEXT,
               sequence.seqcycle::TEXT
             )
             ELSE ''
           END) AS definition_hash
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_sequence AS sequence ON sequence.seqrelid = relation.oid
    WHERE namespace.nspname IN ('runtime', 'session')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'i')
    ORDER BY namespace.nspname COLLATE "C",
             relation.relkind::TEXT COLLATE "C",
             relation.relname COLLATE "C"
  `);
  const constraints = await pool.query(`
    SELECT namespace.nspname AS schema_name,
           relation.relname AS table_name,
           constraint_record.conname AS constraint_name,
           constraint_record.contype::TEXT AS constraint_kind,
           MD5(pg_get_constraintdef(constraint_record.oid, TRUE)) AS definition_hash
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('runtime', 'session')
    ORDER BY namespace.nspname COLLATE "C",
             relation.relname COLLATE "C",
             constraint_record.conname COLLATE "C"
  `);
  const columns = await pool.query(`
    SELECT namespace.nspname AS schema_name,
           relation.relname AS relation_name,
           column_record.attname AS column_name,
           format_type(column_record.atttypid, column_record.atttypmod) AS data_type,
           column_record.attnotnull::TEXT AS not_null,
           MD5(COALESCE(pg_get_expr(attribute_default.adbin, attribute_default.adrelid, TRUE), '')) AS default_hash,
           column_record.attidentity::TEXT AS identity_kind,
           column_record.attgenerated::TEXT AS generated_kind,
           COALESCE(collation_record.collname, '') AS collation_name
    FROM pg_attribute AS column_record
    INNER JOIN pg_class AS relation ON relation.oid = column_record.attrelid
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef AS attribute_default
      ON attribute_default.adrelid = column_record.attrelid
     AND attribute_default.adnum = column_record.attnum
    LEFT JOIN pg_collation AS collation_record ON collation_record.oid = column_record.attcollation
    WHERE namespace.nspname IN ('runtime', 'session')
      AND relation.relkind IN ('r', 'p', 'v', 'm')
      AND column_record.attnum > 0
      AND column_record.attisdropped = FALSE
    ORDER BY namespace.nspname COLLATE "C",
             relation.relname COLLATE "C",
             column_record.attname COLLATE "C"
  `);
  const relationTuples = relations.rows.map((row) => [
    row.schema_name,
    row.object_name,
    row.object_kind,
    row.definition_hash,
  ]);
  const constraintTuples = constraints.rows.map((row) => [
    row.schema_name,
    row.table_name,
    row.constraint_name,
    row.constraint_kind,
    row.definition_hash,
  ]);
  const columnTuples = columns.rows.map((row) => [
    row.schema_name,
    row.relation_name,
    row.column_name,
    row.data_type,
    row.not_null,
    row.default_hash,
    row.identity_kind,
    row.generated_kind,
    row.collation_name,
  ]);
  if (JSON.stringify(relationTuples) !== JSON.stringify(PANDA_EXPECTED_RELATIONS)) {
    throw new Error("Fresh/legacy relation catalog differs from schema-object-manifest.ts.");
  }
  if (JSON.stringify(constraintTuples) !== JSON.stringify(PANDA_EXPECTED_CONSTRAINTS)) {
    throw new Error("Fresh/legacy constraint catalog differs from schema-object-manifest.ts.");
  }
  if (JSON.stringify(columnTuples) !== JSON.stringify(PANDA_EXPECTED_COLUMNS)) {
    throw new Error("Fresh/legacy column catalog differs from schema-object-manifest.ts.");
  }
}

async function runScenario(name: string, fixturePath?: string): Promise<void> {
  const target = await recreateSmokeDatabase(requireTestDatabaseUrl());
  const pool = createPostgresPool({
    connectionString: target.connectionString,
    applicationName: `panda/ci-postgres-${name}`,
    max: 1,
  });

  try {
    if (fixturePath) {
      await prepareLegacyFixtureBase(pool);
      await applyFixture(pool, fixturePath);
    }
    let appliedEvents = 0;
    const migrator = createPandaSchemaMigrator({
      pool,
      readonlyRole: null,
      log: (event) => {
        if (event === "migration_applied") appliedEvents += 1;
      },
    });
    await migrator.migrate();
    if (appliedEvents !== PANDA_SCHEMA_MIGRATIONS.length) {
      throw new Error(`Expected ${PANDA_SCHEMA_MIGRATIONS.length} migrations, observed ${appliedEvents}.`);
    }
    await migrator.migrate();
    if (appliedEvents !== PANDA_SCHEMA_MIGRATIONS.length) {
      throw new Error("Expected a second migration pass to be a no-op.");
    }
    await assertCoreRelations(pool);
    await assertBaselineCutover(pool);
    await assertLegacyThreadContextColumnDropped(pool);
    await assertReadonlyExamplesExecute(pool);
    await runPandaDatabaseIntegrityChecks(pool);
    await assertSchemaObjectManifestExact(pool);
    process.stdout.write(`Postgres startup rehearsal passed: ${name}\n`);
  } finally {
    await pool.end();
  }
}

async function runRejectedLegacyScenario(
  name: string,
  mutationFixture: string,
  expectedMessage: string,
): Promise<void> {
  const target = await recreateSmokeDatabase(requireTestDatabaseUrl());
  const pool = createPostgresPool({
    connectionString: target.connectionString,
    applicationName: `panda/ci-postgres-${name}`,
    max: 1,
  });

  try {
    await prepareLegacyFixtureBase(pool);
    await applyFixture(pool, path.join(fixtureDir, "legacy-minimal.sql"));
    await applyFixture(pool, path.join(fixtureDir, mutationFixture));
    const before = await pool.query(`
      SELECT message, metadata
      FROM runtime.inputs
      WHERE id = '00000000-0000-4000-8000-000000000010'
    `);
    let rejected = false;
    try {
      await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    } catch (error) {
      rejected = error instanceof Error && error.message.includes(expectedMessage);
    }
    if (!rejected) throw new Error(`Expected ${name} migration to reject unsafe legacy data.`);
    const after = await pool.query(`
      SELECT message, metadata
      FROM runtime.inputs
      WHERE id = '00000000-0000-4000-8000-000000000010'
    `);
    if (JSON.stringify(after.rows) !== JSON.stringify(before.rows)) {
      throw new Error(`Expected ${name} rollback to preserve the legacy input payload.`);
    }
    const ledger = await pool.query("SELECT to_regclass('runtime.schema_migrations') AS relation");
    if (ledger.rows[0]?.relation !== null) {
      throw new Error(`Expected ${name} rollback to remove the migration ledger.`);
    }
    process.stdout.write(`Postgres startup rehearsal rejected unsafe legacy data: ${name}\n`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  await runScenario("fresh");
  for (const fixturePath of await listFixtures()) {
    await runScenario(path.basename(fixturePath, ".sql"), fixturePath);
  }
  await runRejectedLegacyScenario("missing-input-message", "rejected-missing-input-message.sql", "canonical message");
  await runRejectedLegacyScenario("ambiguous-input-message", "rejected-ambiguous-input-message.sql", "canonical message");
  await runRejectedLegacyScenario(
    "malformed-typed-checkpoint",
    "rejected-malformed-typed-checkpoint.sql",
    "malformed compaction checkpoints",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
