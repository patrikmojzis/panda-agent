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
- `key_version SMALLINT NOT NULL`
- `created_at`
- `updated_at`

There is one value per `(agent_key, env_key)`.

## Migration

`PostgresCredentialStore.ensureSchema()` migrates the old table shape by keeping old agent-owned rows and deleting rows that cannot map to a single agent credential. The final schema has no owner dimension beyond `agent_key`.

## Encryption

Values are encrypted in app code with `CREDENTIALS_MASTER_KEY`.

- algorithm: AES-256-GCM
- key derivation: SHA-256 of the configured master key string
- storage: ciphertext, IV, and tag are stored separately
- plaintext never goes to Postgres

The store still uses `BYTEA`, but v1 base64-wraps the encrypted blobs before writing them there. That looks a little weird until you remember `pg-mem` mangles raw bytes and turns test data into soup.

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

- ensures the credentials schema
- builds a `CredentialResolver` for bash and credential-using adapters
- builds a `CredentialService` only when `CREDENTIALS_MASTER_KEY` exists
- registers `set_env_value` and `clear_env_value` only when decryption is actually possible

`BashTool` resolves credentials on every execution using the thread `agentKey`.

Local bash merges env in this order:

`process env -> stored credentials -> persisted shell session env -> bash.env`

Remote bash merges env in this order:

`stored credentials -> persisted shell session env -> bash.env`

Remote intentionally does not inherit core host env or runner host env. If it did, the runner boundary would be fake.

## Redaction

There are two redaction layers:

1. Tool-call redaction before transcript persistence for tools that opt in.
2. Bash result redaction for secret values carried by stored credentials or `bash.env`.

Current behavior:

- `set_env_value` currently keeps the `value` argument in transcript history so the agent does not replay `[redacted]` as a credential
- `bash` redacts `env` argument values
- `bash` also replaces echoed credential or `bash.env` values in stdout/stderr with `[redacted]`

Still true:

- a secret pasted directly into chat is not hidden
- a secret pasted literally into the bash command string is not a hidden-input path

That is why the user docs push humans toward the CLI.
