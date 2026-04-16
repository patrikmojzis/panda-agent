import {Pool} from "pg";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveDatabaseUrl(explicitDbUrl?: string): string | null {
  return (
    trimNonEmptyString(explicitDbUrl)
    ?? trimNonEmptyString(process.env.DATABASE_URL)
  );
}

export function requireDatabaseUrl(explicitDbUrl?: string): string {
  const dbUrl = resolveDatabaseUrl(explicitDbUrl);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Panda requires Postgres. Pass --db-url or set DATABASE_URL.");
}

export function createPostgresPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
  });
}
