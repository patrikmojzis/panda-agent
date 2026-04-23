## Example Apps

These are hand-built micro-apps you can copy into Panda's app directory while the contract is still settling.

The runtime only cares about `manifest.json`, `views.json`, `actions.json`, `public/`, and `data/app.sqlite`.
Files like `schema.sql` and `README.md` are for humans and agents to bootstrap the SQLite file without inventing the schema from scratch every time.

- `counter`: smallest useful app; one view, silent native actions, no page-load mutation.
- `period-tracker`: identity-scoped personal logging with `native+wake`, validation, pagination, and charts.
- `context-capsule`: identity-scoped memory cards with search params, tags, review queues, pagination, and wake-backed capture.
- `ops-radar`: shared incident board with filters, activity pagination, multi-statement actions, and wake-backed escalations.

Seed data belongs in `schema.sql`, not in a normal live-app button.
If an example needs deterministic identity-scoped demo rows, prefer a local-only `?identityId=demo-identity` note and use `app_link_create` for real human sessions.
