# Database migrations

Panda changes its Postgres schema during deployment, never during application startup. The runtime, gateway, channel workers, and operator commands are schema consumers. They must fail fast when the database revision does not match the running build.

## Ownership

- Domain Postgres modules own their tables, data migrations, and integrity checks.
- `src/app/database/migrations` owns the ordered, append-only migration catalog.
- `src/lib/postgres-migrations.ts` owns only the generic transaction, advisory lock, and ledger mechanics.
- `runtime.schema_migrations` is the sole schema-history ledger.

The initial migration is a frozen baseline that absorbs every schema shipped before the ledger. Its generated implementation vendors the complete executable helper graph, and its `pre-ledger/0001-schema-version.ts` pin preserves the exact metadata import graph covered by the published checksum. Later edits to domain schema test fixtures or generic Postgres helpers therefore cannot rewrite 0001. CI rejects any behavioral edit to that closed artifact. Never regenerate or hand-edit the released baseline; add the next ordered migration instead. The old domain installers remain only for lightweight database test setup and are not production schema paths. Forward-only expand/contract migrations are preferred when an old and new build must overlap during a rolling deployment; a deliberate hard cut must stop all Panda database writers first.

## Deploy contract

`scripts/docker-stack.sh up` and `restart` use this order:

1. Render configuration and build images while the old stack is still serving.
2. Discover the previous deployment by Compose project/service labels and stop every running Panda database writer, including channels or a generated gateway disabled by the new configuration.
3. Run `panda db migrate --writers-stopped` as a one-shot container.
4. Start the stack and wait for the core health endpoint.

The migrator opens one transaction, acquires a transaction-scoped advisory lock, applies every pending migration through that same connection, records their ledger rows, reconciles database-owned deployment configuration, and commits. A failure rolls the entire pending batch back. The stack script leaves writers stopped when migration fails; inspect and fix the failure before restarting anything.

The core health check has a 180-second start period as cold-start insurance. It is not migration capacity: schema work must already be complete before core starts.

## Operator commands

```text
panda db status
panda db migrate --writers-stopped
panda db check
```

- `status` is read-only and reports applied, pending, unknown, or changed migration metadata.
- `migrate` is the only production schema mutation path. Its mandatory
  `--writers-stopped` acknowledgement makes the maintenance-window contract
  explicit for direct invocations; the stack script supplies it only after it
  has stopped every discovered writer.
- `check` audits the structural manifest and PostgreSQL constraint/index health in a read-only transaction. It never repairs data or invokes migration code.
  It also verifies the checked-in structural manifest of required relations,
  columns, views, sequences, indexes, and constraints, catching manual loss or
  definition drift that a ledger row alone cannot see.

An older build rejects a database containing unknown migrations. A build also rejects a changed checksum/description or an applied history that is not an exact catalog prefix. These checks prevent accidental downgrade, rewritten history, and running an older missing migration against a newer schema.

## Readonly role configuration

The `session.*` views are schema and therefore created by a migration. Grants are deployment configuration because `READONLY_DATABASE_URL` can be added, removed, or changed later. `db migrate --writers-stopped` reconciles grants only when `READONLY_DATABASE_URL` or `--read-only-db-url` selects a role. Omitting both preserves the recorded role; it does not silently revoke access. Use `--clear-read-only-role` for an intentional revoke. Replacing or clearing a role updates `runtime.schema_configuration` in the migration transaction.

## Adding a migration

1. Add one ordered migration module under `src/app/database/migrations`, add its immutable summary under `src/integrations/postgres/schema-versions`, append that summary to `PANDA_SCHEMA_VERSION`, and register the executable entry point in `PANDA_SCHEMA_MIGRATION_SOURCES`. CI bundles every entry point and rejects checksum drift.
2. Keep all SQL and data repair on the supplied `PgQueryable`. Never acquire another client or open a nested transaction.
3. Put destructive preconditions and one-time integrity checks in the migration. Export ongoing invariants to the `db check` catalog as well.
4. Add real-Postgres coverage for fresh install, upgrade from checked-in historical SQL, rollback, and a second no-op run. Never construct a legacy fixture with current schema installers. Use concurrency coverage when locks or unique constraints are involved.
5. Migrate a fresh disposable database, run
   `pnpm ci:postgres-schema-manifest:update`, and review the generated object
   diff. Update the relevant subsystem documentation and run
   `pnpm ci:postgres-startup`; the rehearsal requires fresh and every legacy
   fixture to converge on the exact same object catalog.

Migration bodies may assume the stack has stopped Panda writers, but must not assume an empty database. They must handle every supported pre-ledger fixture and fail with a specific error when safe repair is impossible.

Both waits are bounded: the migrator allows 60 seconds to acquire its advisory
lock and, after ownership is established, five minutes per database lock needed
by DDL or grant reconciliation. A DDL timeout means another database writer or
session still conflicts with the maintenance window; it is not retried inside
the transaction.
