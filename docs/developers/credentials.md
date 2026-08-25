# Credentials

`src/domain/credentials` is Panda runtime plumbing. It is intentionally not a public package export.

## Shape

One Postgres table stores agent-owned env credentials:

- `id UUID`
- `agent_key TEXT NOT NULL`
- `env_key TEXT NOT NULL`
- `value_ciphertext BYTEA NOT NULL`
- `value_iv BYTEA NOT NULL`
- `value_tag BYTEA NOT NULL`
- `envelope_version SMALLINT NOT NULL CHECK (envelope_version >= 2)`
- `created_at`
- `updated_at`

There is one value per `(agent_key, env_key)`.

## Schema Migration

Migration `0009_bound_secret_envelopes` rewraps all persisted v1 secrets while database writers are stopped. A database with v1 rows must run the migration with the same `CREDENTIALS_MASTER_KEY` that encrypted them. Missing, wrong, or corrupted key material aborts the whole transaction and leaves the migration ledger untouched. Empty databases do not require the key.

The migration covers agent credentials, connector secrets, WhatsApp auth state, Wiki tokens, and MCP OAuth state. Expired or consumed OAuth attempts are deleted before rewrapping.

Deploy with the normal `docker-stack.sh up` ordering: build the new image, stop every Panda database writer, run migrations, then start the new processes. After `0009` commits, an old Panda build is not a rollback target; its schema verifier rejects the newer ledger before runtime construction.

## Encryption

Values are encrypted in app code with `CREDENTIALS_MASTER_KEY`.

- algorithm: AES-256-GCM
- root key: SHA-256 of the configured master key string
- envelope key: HKDF-SHA-256 derived per secret purpose
- associated data: envelope version, purpose, and the row's complete secret identity
- storage: ciphertext, IV, and tag are stored separately
- plaintext never goes to Postgres

The store still uses `BYTEA`, but envelopes base64-wrap the encrypted blobs before writing them there. That looks a little weird until you remember `pg-mem` mangles raw bytes and turns test data into soup.

The steady-state reader accepts v2 only. Moving a valid ciphertext tuple to another agent, key, connector account, WhatsApp key, Wiki binding, or MCP OAuth row fails authentication.

## Validation

Env keys must match a shell-safe format:

`^[A-Za-z_][A-Za-z0-9_]*$`

Blocked names include runtime-owned or dangerous keys such as:

- `PANDA_*`
- `PATH`
- `HOME`
- `BASH_ENV`
- `NODE_OPTIONS`
- `LD_PRELOAD`

## Runtime Wiring

`createRuntime()` does the setup:

- verifies the global database migration revision before constructing stores
- builds a `CredentialResolver` for bash and credential-using adapters
- builds a `CredentialService` only when `CREDENTIALS_MASTER_KEY` exists
- grants `panda env set` and `panda env clear` only when decryption is actually possible

`BashTool` resolves credentials on every execution using the thread `agentKey`.

Local bash merges env in this order:

`process env -> stored credentials -> persisted shell session env -> bash.env`

Remote bash merges env in this order:

`stored credentials -> persisted shell session env -> bash.env`

Remote intentionally does not inherit core host env or runner host env. If it did, the runner boundary would be fake.

## Redaction

There are two explicit redaction layers:

1. Tool-call redaction before transcript persistence for tools that opt in.
2. Bash result redaction for known secret values carried by stored credentials or `bash.env`.

Panda does not run generic token-shaped prose redaction. Strings such as
`token=...`, `Bearer ...`, app launch URLs, or `sk-...` are not rewritten merely
because they look secret-shaped. Privacy comes from explicit secret-entry paths,
scoped storage, and tools that know exactly which values they are handling.

Current behavior:

- `panda env set` currently keeps the value argument in transcript history so the agent does not replay `[redacted]` as a credential
- `bash` redacts `env` argument values
- `bash` also replaces echoed known credential or `bash.env` values in stdout/stderr with `[redacted]`
- stored credential metadata such as usernames, owners, or repo names is not a global redaction candidate

Still true:

- a secret pasted directly into chat is not hidden
- a secret pasted literally into the bash command string is not a hidden-input path

That is why the user docs push humans toward the CLI.
