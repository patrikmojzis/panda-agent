# Credentials

Panda can store secret env values in Postgres and inject them into `bash`.

Credentials belong to one agent. There is no per-human credential layer.

This is for bash and credential-using adapters in v1. Not every tool gets these values.

## Use The CLI

Human-entered secrets should go through the CLI, not chat text. Chat is not a hidden-input channel.

Prefer `--stdin` or the hidden prompt:

```bash
panda credentials set NOTION_API_KEY --agent panda
printf '%s' "$GITHUB_TOKEN" | panda credentials set GITHUB_TOKEN --stdin --agent work
printf '%s' "$SLACK_BOT_TOKEN" | panda credentials set SLACK_BOT_TOKEN --stdin --agent slack-bot
```

Inline values work, but they are convenience-only:

```bash
panda credentials set OPENAI_API_KEY sk-example --agent panda
```

Useful commands:

```bash
panda credentials list
panda credentials list --agent panda
panda credentials resolve NOTION_API_KEY --agent panda
panda credentials clear NOTION_API_KEY --agent panda
```

## Resolve Command

`panda credentials resolve` inspects the credentials store only.

It does not inspect:

- active shell-session env from a running thread
- per-call `bash.env`
- the full runtime env merge inside a real bash invocation

That means:

- if it finds a winner, that is the stored winner only
- if it finds nothing, local bash may still fall back to Panda process env
- remote bash does not fall back to runner host env

## How Bash Sees It

Local bash merges env in this order:

`process env -> stored credentials -> persisted shell session env -> bash.env`

Remote bash merges env in this order:

`stored credentials -> persisted shell session env -> bash.env`

Remote runners do not inherit the host env and do not own static secrets.

## Clear vs Unset

This trips people up, so here it is plainly:

- `panda credentials clear KEY --agent AGENT` deletes the stored credential.
- `unset KEY` inside bash does not delete the stored credential.

If a stored credential still exists, Panda will inject it again on the next bash call.

After a clear:

- if no stored credential has that key, local bash may still fall back to Panda process env
- remote bash does not fall back to runner host env

## Agent Tools

Panda also gets two tools:

- `set_env_value(key, value)`
- `clear_env_value(key)`

The model should use these only for values it already has. Humans should still prefer the CLI.
