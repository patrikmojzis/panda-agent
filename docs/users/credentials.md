# Credentials

Panda v1 can store secret env values in Postgres and inject them into `bash`.

This is for bash only in v1. Not every tool gets these values.

## Scope Model

Panda supports three scopes:

- `relationship`: one identity talking to one agent. This is the default and the recommended path.
- `agent`: one agent across identities. Use this for service-account style creds or agent-owned bot tokens.
- `identity`: one identity across agents. Supported in the CLI, but not writable by the model in v1.

UX copy stays human:

- `--identity` means "who owns this credential?"
- `--agent` means "which persona should receive it?"

Scope mapping is explicit:

- `--agent` + `--identity` = `relationship`
- `--agent` only = `agent`
- `--identity` only = `identity`

## Use The CLI

Human-entered secrets should go through the CLI, not chat text. Chat is not a hidden-input channel.

Prefer `--stdin` or the hidden prompt:

```bash
panda credentials set NOTION_API_KEY --agent panda --identity patrik
printf '%s' "$GITHUB_TOKEN" | panda credentials set GITHUB_TOKEN --stdin --agent work --identity patrik
printf '%s' "$SLACK_BOT_TOKEN" | panda credentials set SLACK_BOT_TOKEN --stdin --agent slack-bot
```

Inline values work, but they are convenience-only:

```bash
panda credentials set OPENAI_API_KEY sk-example --agent panda --identity patrik
```

Useful commands:

```bash
panda credentials list
panda credentials list --agent panda --identity patrik
panda credentials resolve NOTION_API_KEY --agent panda --identity patrik
panda credentials clear NOTION_API_KEY --agent panda --identity patrik
```

## Precedence

Stored credential precedence is:

`relationship > agent > identity`

If two stored scopes define the same key, the more specific one wins.

## How Bash Sees It

Local bash merges env in this order:

`process env -> stored credentials -> persisted shell session env -> bash.env`

Remote bash merges env in this order:

`stored credentials -> persisted shell session env -> bash.env`

Remote runners do not inherit the host env and do not own static secrets.

## Clear vs Unset

This trips people up, so here it is plainly:

- `panda credentials clear KEY ...` deletes the stored credential for one exact scope.
- `unset KEY` inside bash does not delete the stored credential.

If a stored credential still exists, Panda will inject it again on the next bash call.

After a clear:

- if another stored scope still has that key, that scope wins next
- if no stored scope has that key, local bash may still fall back to Panda process env
- remote bash does not fall back to runner host env

## Agent Tools

Panda also gets two tools:

- `set_env_value(key, value, scope?)`
- `clear_env_value(key, scope?)`

Defaults:

- default scope is `relationship`
- explicit `scope: "agent"` is allowed
- `identity` writes are CLI-only in v1

The model should use these only for values it already has. Humans should still prefer the CLI.
