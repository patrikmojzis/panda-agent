import {describe, expect, it} from "vitest";

import {assertPandaSchemaObjectManifest} from "../src/app/database/schema-object-catalog.js";
import {
  PANDA_EXPECTED_COLUMNS,
  PANDA_EXPECTED_CONSTRAINTS,
  PANDA_EXPECTED_RELATIONS,
} from "../src/app/database/schema-object-manifest.js";
import type {PgClientLike, PgPoolLike, PgQueryResult} from "../src/lib/postgres-query.js";

class SchemaCatalogDatabaseFake implements PgPoolLike {
  readonly queries: string[] = [];
  releaseCount = 0;
  changedColumn = false;

  private readonly client: PgClientLike = {
    query: (sql) => this.query(sql),
    release: () => {
      this.releaseCount += 1;
    },
  };

  async connect(): Promise<PgClientLike> {
    return this.client;
  }

  async query(sql: string): Promise<PgQueryResult> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);
    if (normalized.includes("LEFT JOIN pg_sequence")) {
      return {
        rows: PANDA_EXPECTED_RELATIONS.map(([schemaName, objectName, objectKind, definitionHash]) => ({
          schema_name: schemaName,
          object_name: objectName,
          object_kind: objectKind,
          definition_hash: definitionHash,
        })),
      };
    }
    if (normalized.includes("FROM pg_constraint AS constraint_record")) {
      return {
        rows: PANDA_EXPECTED_CONSTRAINTS.map(([
          schemaName,
          tableName,
          constraintName,
          constraintKind,
          definitionHash,
        ]) => ({
          schema_name: schemaName,
          table_name: tableName,
          constraint_name: constraintName,
          constraint_kind: constraintKind,
          definition_hash: definitionHash,
        })),
      };
    }
    if (normalized.includes("FROM pg_attribute AS column_record")) {
      return {
        rows: PANDA_EXPECTED_COLUMNS.map(([
          schemaName,
          relationName,
          columnName,
          dataType,
          notNull,
          defaultHash,
          identityKind,
          generatedKind,
          collationName,
        ]) => ({
          schema_name: schemaName,
          relation_name: relationName,
          column_name: columnName,
          data_type: dataType,
          not_null: notNull,
          default_hash: this.changedColumn && columnName === "model_applied_at" ? "changed" : defaultHash,
          identity_kind: identityKind,
          generated_kind: generatedKind,
          collation_name: collationName,
        })),
      };
    }
    return {rows: []};
  }
}

describe("Panda schema object catalog", () => {
  it("validates the manifest in a UTC-normalized read-only snapshot", async () => {
    const database = new SchemaCatalogDatabaseFake();

    await assertPandaSchemaObjectManifest(database);

    expect(database.queries[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(database.queries[1]).toBe("SET LOCAL TIME ZONE 'UTC'");
    expect(database.queries.at(-1)).toBe("COMMIT");
    expect(database.releaseCount).toBe(1);
  });

  it("names changed schema objects in the failure", async () => {
    const database = new SchemaCatalogDatabaseFake();
    database.changedColumn = true;

    await expect(assertPandaSchemaObjectManifest(database)).rejects.toThrow(
      "schema manifest differs (1 mismatch): changed column runtime.session_runtime_config.model_applied_at",
    );
  });
});
