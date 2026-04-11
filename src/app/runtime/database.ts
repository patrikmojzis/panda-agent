import {Pool} from "pg";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function resolvePandaDatabaseUrl(explicitDbUrl?: string): string | null {
  return (
    trimNonEmptyString(explicitDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_DATABASE_URL)
    ?? trimNonEmptyString(process.env.DATABASE_URL)
  );
}

export function requirePandaDatabaseUrl(explicitDbUrl?: string): string {
  const dbUrl = resolvePandaDatabaseUrl(explicitDbUrl);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Panda requires Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export function createPandaPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
  });
}
