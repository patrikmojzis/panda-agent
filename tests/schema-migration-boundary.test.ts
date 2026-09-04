import {readdir, readFile} from "node:fs/promises";
import path from "node:path";

import {describe, expect, it} from "vitest";

import {PRE_LEDGER_SCHEMA_FIXTURE_SOURCE_FILES} from "../src/app/database/migrations/0001-pre-ledger-baseline.js";

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  }));
  return nested.flat();
}

describe("database migration boundary", () => {
  it("keeps runtime and stores free of schema self-migration escape hatches", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../src");
    const violations: string[] = [];
    for (const file of await listTypeScriptFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      const relativeFile = path.relative(sourceRoot, file);
      const isMigration = relativeFile.startsWith(`app${path.sep}database${path.sep}migrations${path.sep}`);
      const definesSchemaInstaller = /export\s+async\s+function\s+(?:ensure|installPreLedger)\w*Schema\s*\(/.test(source);
      const callsSchemaInstaller = /\b(?:ensure|installPreLedger)\w*Schema\s*\(/.test(source);
      const hasStoreEscapeHatch = /\.ensureSchema\s*\(/.test(source) || /\bensureSchemas\s*\(/.test(source);
      if (hasStoreEscapeHatch || (callsSchemaInstaller && !isMigration && !definesSchemaInstaller)) {
        violations.push(relativeFile);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps schema DDL behind an explicit migration-owned allowlist", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../src");
    const allowed = new Set([
      ...PRE_LEDGER_SCHEMA_FIXTURE_SOURCE_FILES.map((file) => file.replace(/^src\//, "")),
      "app/database/migrations/pre-ledger/0001-pre-ledger-baseline.generated.ts",
      "app/database/migrations/0002-thread-input-admission.ts",
      "app/database/migrations/0003-thread-wake-generation.ts",
      "app/database/migrations/0004-thread-abort-operations.ts",
      "app/database/migrations/0005-runtime-operation-receipts.ts",
      "app/database/migrations/0006-thread-input-cutoffs.ts",
      "app/database/migrations/0007-reset-run-fences.ts",
      "app/database/migrations/0008-legacy-schema-reconciliation.ts",
      "app/database/migrations/0009-session-archive.ts",
      "app/database/migrations/0010-refresh-archived-session-view.ts",
      "app/database/migrations/0011-bound-secret-envelopes.ts",
      "app/database/migrations/0013-scheduled-commands.ts",
      "app/database/migrations/0014-email-recipient-allow-rules.ts",
      "app/database/migrations/0015-agent-live-voice.ts",
      "app/database/migrations/0016-whatsapp-call-controls.ts",
      "app/database/migrations/0017-channel-action-expiry.ts",
      "app/database/migrations/0019-heartbeat-cadence.ts",
      "domain/sessions/compaction-postgres-schema.ts",
      "app/database/readonly-role.ts",
      "domain/threads/requests/postgres-operation-schema.ts",
      "lib/postgres-migrations.ts",
      "lib/postgres-relations.ts",
    ].map((file) => file.split("/").join(path.sep)));
    const ddlPattern = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:SCHEMA|TABLE|INDEX|VIEW|TYPE|FUNCTION|TRIGGER|POLICY|EXTENSION)\b|\b(?:ALTER|DROP)\s+(?:SCHEMA|TABLE|INDEX|VIEW|TYPE|FUNCTION|TRIGGER|POLICY|EXTENSION)\b|\bCOMMENT\s+ON\b|\b(?:GRANT|REVOKE)\b/;
    const actual: string[] = [];

    for (const file of await listTypeScriptFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      if (ddlPattern.test(source)) actual.push(path.relative(sourceRoot, file));
    }

    expect(actual.filter((file) => !allowed.has(file)).toSorted()).toEqual([]);
    expect([...allowed].filter((file) => !actual.includes(file)).toSorted()).toEqual([]);
  });
});
