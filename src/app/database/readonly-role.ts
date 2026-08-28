import type {PgQueryable} from "../../lib/postgres-query.js";
import {
  buildRuntimeRelationNames,
  buildSessionRelationNames,
  quoteIdentifier,
  SESSION_SCHEMA,
} from "../../lib/postgres-relations.js";
import {CURRENT_READONLY_SESSION_VIEW_DEFINITIONS} from "../../integrations/postgres/readonly-session-views.js";

const READONLY_ROLE_CONFIGURATION_KEY = "readonly_session_role";

function configuredRole(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const value = (row as {configuration_value?: unknown}).configuration_value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function roleExists(queryable: PgQueryable, role: string): Promise<boolean> {
  const result = await queryable.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  return result.rows.length > 0;
}

/**
 * Reconciles environment-owned grants on every deploy. The selected role is
 * configuration, not schema history, so it must remain changeable after the
 * view-creation migration has been recorded.
 */
export async function reconcileReadonlySessionRole(
  queryable: PgQueryable,
  readonlyRole: string | null,
): Promise<void> {
  const configurationTable = buildRuntimeRelationNames({
    schemaConfiguration: "schema_configuration",
  }).schemaConfiguration;
  const {prefix: _prefix, ...views} = buildSessionRelationNames(CURRENT_READONLY_SESSION_VIEW_DEFINITIONS);
  const viewList = Object.values(views).join(", ");

  const existing = await queryable.query(`
    SELECT configuration_value
    FROM ${configurationTable}
    WHERE configuration_key = $1
  `, [READONLY_ROLE_CONFIGURATION_KEY]);
  const previousRole = configuredRole(existing.rows[0]);

  if (previousRole && previousRole !== readonlyRole && await roleExists(queryable, previousRole)) {
    const quotedPreviousRole = quoteIdentifier(previousRole);
    await queryable.query(`
      REVOKE SELECT ON ${viewList} FROM ${quotedPreviousRole};
      REVOKE USAGE ON SCHEMA ${quoteIdentifier(SESSION_SCHEMA)} FROM ${quotedPreviousRole};
    `);
  }

  if (readonlyRole) {
    if (!await roleExists(queryable, readonlyRole)) {
      throw new Error(`Configured readonly Postgres role ${readonlyRole} does not exist.`);
    }
    const quotedReadonlyRole = quoteIdentifier(readonlyRole);
    await queryable.query(`
      GRANT USAGE ON SCHEMA ${quoteIdentifier(SESSION_SCHEMA)} TO ${quotedReadonlyRole};
      GRANT SELECT ON ${viewList} TO ${quotedReadonlyRole};
    `);
    await queryable.query(`
      INSERT INTO ${configurationTable} (configuration_key, configuration_value)
      VALUES ($1, $2)
      ON CONFLICT (configuration_key)
      DO UPDATE SET configuration_value = EXCLUDED.configuration_value, updated_at = NOW()
    `, [READONLY_ROLE_CONFIGURATION_KEY, readonlyRole]);
    return;
  }

  await queryable.query(`
    DELETE FROM ${configurationTable}
    WHERE configuration_key = $1
  `, [READONLY_ROLE_CONFIGURATION_KEY]);
}
