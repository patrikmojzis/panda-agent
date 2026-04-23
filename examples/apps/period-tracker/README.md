## Period Tracker

This is the first non-toy app in the repo.

It is identity-scoped, so open it with a query string like `?identityHandle=angelina`.
The `log_entry` action uses `native+wake`, so HTTP writes can also wake Panda's main session for a short follow-up.

Bootstrap the SQLite file:

```sh
mkdir -p ~/.panda/agents/panda/apps/period-tracker/data
sqlite3 ~/.panda/agents/panda/apps/period-tracker/data/app.sqlite < ~/.panda/agents/panda/apps/period-tracker/schema.sql
```

The runtime ignores `schema.sql`; it exists so a human or agent can create the database without guessing.
