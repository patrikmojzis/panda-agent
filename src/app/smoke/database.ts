import {Pool} from "pg";

import {quoteIdentifier} from "../../domain/threads/runtime/postgres-shared.js";

export interface SmokeDatabaseTarget {
  adminConnectionString: string;
  connectionString: string;
  databaseName: string;
}

function requireDatabaseName(connectionString: string): string {
  const url = new URL(connectionString);
  const rawPath = url.pathname.replace(/^\/+/, "");
  const databaseName = decodeURIComponent(rawPath.split("/")[0] ?? "");
  if (!databaseName) {
    throw new Error("Smoke database URL must include a database name.");
  }

  return databaseName;
}

export function looksLikeDisposableDatabaseName(databaseName: string): boolean {
  return /(test|smoke|tmp)/i.test(databaseName);
}

export function resolveSmokeDatabaseTarget(connectionString: string): SmokeDatabaseTarget {
  const databaseName = requireDatabaseName(connectionString);
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";

  return {
    adminConnectionString: adminUrl.toString(),
    connectionString,
    databaseName,
  };
}

export async function recreateSmokeDatabase(
  connectionString: string,
  options: {allowUnsafeReset?: boolean} = {},
): Promise<SmokeDatabaseTarget> {
  const target = resolveSmokeDatabaseTarget(connectionString);
  if (!options.allowUnsafeReset && !looksLikeDisposableDatabaseName(target.databaseName)) {
    throw new Error(
      `Refusing to reset ${target.databaseName}. Use a disposable database name or pass --allow-unsafe-db-reset.`,
    );
  }

  const pool = new Pool({
    connectionString: target.adminConnectionString,
    max: 1,
  });

  try {
    await pool.query(
      `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
      [target.databaseName],
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(target.databaseName)}`);
    await pool.query(`CREATE DATABASE ${quoteIdentifier(target.databaseName)}`);
    return target;
  } finally {
    await pool.end();
  }
}
