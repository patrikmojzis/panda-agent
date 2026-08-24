import process from "node:process";

import type {Command} from "commander";

import {readDatabaseUsername} from "../../domain/threads/runtime/postgres-readonly.js";
import {DB_URL_OPTION_DESCRIPTION} from "../../lib/cli.js";
import {createPostgresPool, requireDatabaseUrl} from "../../lib/postgres-database.js";
import type {PostgresMigrationStatus} from "../../lib/postgres-migrations.js";
import {trimToNull} from "../../lib/strings.js";
import {runPandaDatabaseIntegrityChecks} from "./integrity-catalog.js";
import {createPandaSchemaMigrator} from "./migration-catalog.js";

interface DatabaseCliOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  clearReadOnlyRole?: boolean;
  writersStopped?: boolean;
  json?: boolean;
}

function resolveReadonlyRole(options: DatabaseCliOptions): string | null | undefined {
  if (options.clearReadOnlyRole === true) {
    if (trimToNull(options.readOnlyDbUrl)) {
      throw new Error("--clear-read-only-role cannot be combined with --read-only-db-url.");
    }
    return null;
  }
  const readonlyUrl = trimToNull(options.readOnlyDbUrl) ?? trimToNull(process.env.READONLY_DATABASE_URL);
  if (!readonlyUrl) return undefined;
  const role = readDatabaseUsername(readonlyUrl);
  if (!role) {
    throw new Error("READONLY_DATABASE_URL must contain a Postgres username so grants can be reconciled.");
  }
  return role;
}

function writeStatus(status: PostgresMigrationStatus, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  const state = status.current ? "current" : "not current";
  process.stdout.write(`Panda database schema is ${state}.\n`);
  process.stdout.write(`Applied: ${status.applied.length}; pending: ${status.pending.length}; unknown: ${status.unknownApplied.length}; non-prefix: ${status.nonPrefixApplied.length}; changed: ${status.changedApplied.length}.\n`);
  for (const migration of status.pending) process.stdout.write(`  pending ${migration.id} ${migration.description}\n`);
  for (const migration of status.unknownApplied) process.stdout.write(`  unknown ${migration.id} ${migration.description}\n`);
  for (const migration of status.nonPrefixApplied) process.stdout.write(`  non-prefix ${migration.id} ${migration.description}\n`);
  for (const migration of status.changedApplied) process.stdout.write(`  changed ${migration.id}\n`);
}

async function withDatabase<T>(options: DatabaseCliOptions, operation: (
  pool: ReturnType<typeof createPostgresPool>,
) => Promise<T>): Promise<T> {
  const pool = createPostgresPool({
    connectionString: requireDatabaseUrl(options.dbUrl),
    applicationName: "panda/database",
    max: 1,
  });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

function configureDatabaseOptions(command: Command, options: {readonlyRole?: boolean} = {}): Command {
  command
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .option("--json", "Print machine-readable JSON");
  if (options.readonlyRole) {
    command
      .option(
        "--read-only-db-url <url>",
        "Read-only Postgres URL whose username receives session-view grants",
      )
      .option(
        "--clear-read-only-role",
        "Revoke and forget the currently configured read-only role",
      );
  }
  return command;
}

export function registerDatabaseCommands(program: Command): void {
  const database = program
    .command("db")
    .description("Inspect, migrate, and check the Panda Postgres schema");

  configureDatabaseOptions(database.command("status").description("Report database migration status"))
    .action((options: DatabaseCliOptions) => withDatabase(options, async (pool) => {
      const status = await createPandaSchemaMigrator({pool}).status();
      writeStatus(status, options.json === true);
      if (!status.current) process.exitCode = 1;
    }));

  configureDatabaseOptions(database.command("migrate").description("Apply pending database migrations"), {
    readonlyRole: true,
  })
    .requiredOption(
      "--writers-stopped",
      "Acknowledge that all Panda database writers have been stopped",
    )
    .action((options: DatabaseCliOptions) => withDatabase(options, async (pool) => {
    const migrator = createPandaSchemaMigrator({
      pool,
      readonlyRole: resolveReadonlyRole(options),
      ...(options.json
        ? {}
        : {
            log: (event, migration) => {
              if (event === "migration_started") {
                process.stdout.write(`Applying ${migration.id}: ${migration.description}\n`);
              }
            },
          }),
    });
    writeStatus(await migrator.migrate(), options.json === true);
    }));

  configureDatabaseOptions(database.command("check").description("Run read-only database integrity checks"))
    .action((options: DatabaseCliOptions) => withDatabase(options, async (pool) => {
      await createPandaSchemaMigrator({pool}).assertCurrent();
      const result = await runPandaDatabaseIntegrityChecks(pool);
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ok: true, ...result})}\n`);
      } else {
        process.stdout.write(`Panda database integrity checks passed (${result.checked}).\n`);
      }
    }));
}
