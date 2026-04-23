## Period Tracker

This is the first non-toy app in the repo.

It is identity-scoped. For deterministic local demo data, open it with `?identityId=angelina`.
For real human use, create an app link with `app_link_create`; the signed app session carries the current input identity.
The `log_entry` action uses `native+wake`, so HTTP writes can also wake Panda's main session for a short follow-up.

Bootstrap the SQLite file:

```sh
mkdir -p ~/.panda/agents/panda/apps/period-tracker/data
sqlite3 ~/.panda/agents/panda/apps/period-tracker/data/app.sqlite < ~/.panda/agents/panda/apps/period-tracker/schema.sql
```

The runtime ignores `schema.sql`; it exists so a human or agent can create the database without guessing.
