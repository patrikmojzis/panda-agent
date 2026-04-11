# Credentials

`src/domain/credentials` is Panda runtime plumbing. It is intentionally not a public package export.

## v1 Shape

One Postgres table stores all scopes:

- `id UUID`
- `env_key TEXT`
- `scope TEXT`
- `agent_key TEXT NULL`
- `identity_id TEXT NULL`
- `value_ciphertext BYTEA`
- `value_iv BYTEA`
- `value_tag BYTEA`
- `key_version SMALLINT`
- `created_at`
- `updated_at`

Constraints do the boring but important work:

- `scope` is limited to `relationship | agent | identity`
- `relationship` requires both `agent_key` and `identity_id`
- `agent` requires `agent_key` and forbids `identity_id`
- `identity` requires `identity_id` and forbids `agent_key`

Partial unique indexes enforce one value per exact scope:

- `relationship`: `(identity_id, agent_key, env_key)`
- `agent`: `(agent_key, env_key)`
- `identity`: `(identity_id, env_key)`

## Encryption

Values are encrypted in app code with `PANDA_CREDENTIALS_MASTER_KEY`.

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

## Resolution Order

Stored credential precedence is:

`relationship > agent > identity`

`CredentialResolver.resolveEnvironment()` returns only stored credentials. The final bash env merge happens later:

- local bash: `process env -> stored credentials -> persisted shell session env -> bash.env`
- remote bash: `stored credentials -> persisted shell session env -> bash.env`

Remote intentionally does not inherit core host env or runner host env. If it did, the runner boundary would be fake.

## Runtime Wiring

`createPandaRuntime()` does the setup:

- ensures the credentials schema
- builds a `CredentialResolver` for bash
- builds a `CredentialService` only when `PANDA_CREDENTIALS_MASTER_KEY` exists
- registers `set_env_value` and `clear_env_value` only when decryption is actually possible

`BashTool` resolves credentials on every execution using thread `agentKey` and `identityId`.

Remote mode stays stateless for secrets:

- the runner has no DB
- the runner has no credential files
- the runner does not keep static secret env
- the core sends short-lived env on each `/exec` request

That per-request env may include:

- resolved stored credentials
- persisted shell session env
- explicit `bash.env`

## Redaction

There are two redaction layers:

1. Tool-call redaction before transcript persistence.
2. Bash result redaction for secret values carried by stored credentials or `bash.env`.

Current behavior:

- `set_env_value` redacts the `value` argument
- `bash` redacts `env` argument values
- `bash` also replaces echoed credential or `bash.env` values in stdout/stderr with `[redacted]`

Still true:

- a secret pasted directly into chat is not hidden
- a secret pasted literally into the bash command string is not a hidden-input path

That is why the user docs push humans toward the CLI.
