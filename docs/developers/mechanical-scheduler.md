# Mechanical Scheduler

Panda has two deliberately separate scheduling products:

- `panda schedule` wakes the session and asks the model to perform work.
- `panda cron` executes a shell command without a model call. It belongs to the `operate` tool group.

Mechanical commands are recurring, session-owned, and Postgres-backed. They survive core and runner restarts. Deleting the owning session cascades the command, immutable versions, and run history.

## Enable it

The feature is disabled when neither integrity-key setting is present. For the normal Docker stack, keep the key in the core-only secret mount:

```bash
install -d -m 700 ~/.panda-core-secrets
openssl rand -hex 32 > ~/.panda-core-secrets/scheduled-command-integrity.key
chmod 600 ~/.panda-core-secrets/scheduled-command-integrity.key
```

```dotenv
PANDA_CORE_SECRETS_HOST_ROOT=${HOME}/.panda-core-secrets
PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE=/run/secrets/panda-core/scheduled-command-integrity.key
```

The stack mounts that directory read-only into `panda-core` and explicitly removes both integrity settings from channel containers, even though they share the service env file. The key never enters Postgres or a runner request. Do not store it below `~/.panda`, because channel containers mount that tree for media and connector state.

Local or non-container deployments may instead put the key directly in their owner-only process environment:

```dotenv
PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY=<generated value>
```

The file path must be absolute inside the core process and identify a regular, non-symlink file with no group/other permission bits (`0600`). Set exactly one of `PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY` and `PANDA_SCHEDULED_COMMAND_INTEGRITY_KEY_FILE`; Panda fails startup when both are present. Do not put the key in an agent workspace, Postgres, `CREDENTIALS_MASTER_KEY`, or any environment shared with less-trusted services unless those services explicitly override both settings to empty.

Plain key material must contain at least 32 bytes. Either setting also accepts a rotation keyring:

```json
{
  "currentKeyId": "2026-08",
  "keys": {
    "2026-08": "base64:<base64 key>",
    "2026-07": "base64:<previous base64 key>"
  }
}
```

Retain old keys while stored versions still reference them. Removing a referenced key makes those versions fail closed.
After changing `currentKeyId`, a no-field `panda cron update <command-id> --expected-version <n>` creates an equivalent active version signed by the new key. Keep the previous key until no active or pending occurrence needs it.

## Agent workflow

Create commands disabled, test them manually, then enable them:

```bash
panda cron create "sync gas prices" \
  --cron "0 * * * *" \
  --timezone Europe/Bratislava \
  --command @scripts/sync-gas.sh \
  --credentials GAS_API_TOKEN,METABASE_DATABASE_URL \
  --disabled

panda cron run <command-id> --expected-version 1
panda cron runs <command-id>
panda cron enable <command-id> --expected-version 1
```

Available operations are `list`, `show`, `runs`, `create`, `update`, `enable`, `disable`, `delete`, and `run`. Every mutation uses the current immutable `version`; refresh with `show` after a stale-version failure.

The scheduler accepts any shell command available inside the current default remote execution environment. It does not restrict commands to `.sh` files because a signed wrapper can delegate to mutable TypeScript, Python, binaries, or other scripts. Pin deploy artifacts separately when stronger reproducibility is required.

`--credentials` contains stored credential names, never values. Panda checks their presence and the session environment allowlist when creating or enabling a command, then resolves both again for every occurrence. Omission means no stored credentials are injected.

## Execution and failure behavior

Each occurrence resolves the session's current default environment at the last responsible moment. V1 accepts only the owning agent's persistent remote runner. Local execution could escape into `panda-core`, while disposable workspaces intentionally carry an interactive Panda command-access file; both are rejected. The persistent runner receives the command, scheduler metadata, and explicitly requested credential values. Its constrained child environment does not receive the HMAC key or a Panda command-access token.

Cron uses the same scoped runner transport as interactive foreground and
background bash. The owning agent's derived runner token is selected from the
resolved environment; a token copied from another agent or environment is
rejected before the command reaches the executor.

Occurrence delivery is at least once. A crash after the runner accepts a command but before settlement can replay that occurrence, so scripts must use `PANDA_CRON_RUN_ID` as an idempotency key when side effects matter. `PANDA_CRON_ID` and `PANDA_CRON_SCHEDULED_FOR` are also injected.

Missed intervals are coalesced into one occurrence, and one command can have at most one active or undelivered-notification run. Output is capped, sanitized, secret-redacted, and stored in Postgres; raw output files are not persisted.

The first failure, a changed failure class, and recovery wake the owning session's current thread. Repeated failures with the same class are recorded without repeatedly invoking the model. Notification delivery itself is durable and retried under the occurrence lease.

## Integrity boundary

Every executable definition is an immutable HMAC-SHA-256 version. The signature covers the session, command id, version, title, command text, cwd, cron, timezone, sorted credential names, timeout, and enabled state. A mismatched version is blocked before shell execution and wakes the owning session. It cannot be updated or re-signed through the agent command surface; it can only be deleted.

Before claiming executable work, Panda also requires the occurrence version to match the active version and the active version to be the newest retained version. Reclaimable occurrences that fail this check are cancelled as `superseded_version`; work that already holds a live lease may finish on its pinned version.

This detects unauthorized Postgres modification. It does not protect against rollback to an older still-valid database snapshot, compromise of `panda-core` or its host, or malicious code already present in a mutable child file. Database roles remain the first line of defense; HMAC is the independent execution fence.
