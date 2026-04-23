## Ops Radar

This example is a shared agent-wide operational board.

It demonstrates:

- non-identity-scoped shared data
- view params for status, severity, and text filters
- offset pagination
- multi-statement actions
- `native+wake` actions for meaningful state changes
- silent triage actions for routine maintenance

Bootstrap the SQLite file:

```sh
mkdir -p ~/.panda/agents/panda/apps/ops-radar/data
sqlite3 ~/.panda/agents/panda/apps/ops-radar/data/app.sqlite < ~/.panda/agents/panda/apps/ops-radar/schema.sql
```
