## Context Capsule

This example treats a micro-app as a structured memory surface for one identity.

It demonstrates:

- identity-scoped views and actions
- view params for search and filters
- offset pagination
- array input fields for tags
- `native+wake` capture actions
- silent maintenance actions

For deterministic local demo data, open with `?identityId=demo-identity`.
For real human use, create an app link with `app_link_create`; the signed app session carries the current input identity.

Bootstrap the SQLite file:

```sh
mkdir -p ~/.panda/agents/panda/apps/context-capsule/data
sqlite3 ~/.panda/agents/panda/apps/context-capsule/data/app.sqlite < ~/.panda/agents/panda/apps/context-capsule/schema.sql
```
