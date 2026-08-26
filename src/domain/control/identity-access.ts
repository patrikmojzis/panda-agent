import type {PgPoolLike} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";

/** Owns the atomic database boundary for disabling a Control identity. */
export class PostgresControlIdentityAccess {
  private readonly pool: PgPoolLike;
  private readonly controlTables = buildControlTableNames();
  private readonly identityTables = buildIdentityTableNames();

  constructor(options: {pool: PgPoolLike}) {
    this.pool = options.pool;
  }

  async deleteIdentity(input: {
    identityId: string;
    displayName?: string;
  }): Promise<{deactivatedGrantCount: number; revokedSessionCount: number}> {
    const identityId = requireNonEmptyString(input.identityId, "Identity id is required.");

    return withTransaction(this.pool, async (client) => {
      const identity = await client.query(`
        UPDATE ${this.identityTables.identities}
        SET status = 'deleted',
            display_name = COALESCE($2::TEXT, display_name),
            updated_at = NOW()
        WHERE id = $1
        RETURNING id
      `, [identityId, input.displayName ?? null]);
      if (identity.rows.length === 0) {
        throw new Error(`Unknown identity ${identityId}`);
      }

      const grants = await client.query(`
        UPDATE ${this.controlTables.grants}
        SET active = FALSE,
            updated_at = NOW()
        WHERE identity_id = $1
          AND active = TRUE
        RETURNING id
      `, [identityId]);
      const sessions = await client.query(`
        UPDATE ${this.controlTables.sessions}
        SET revoked_at = NOW()
        WHERE identity_id = $1
          AND revoked_at IS NULL
        RETURNING id
      `, [identityId]);

      return {
        deactivatedGrantCount: grants.rows.length,
        revokedSessionCount: sessions.rows.length,
      };
    });
  }
}
