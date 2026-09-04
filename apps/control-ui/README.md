# Panda Control UI

Panda Control UI is the React/Vite operator console for Panda Agent. It provides authenticated Control screens for agents, sessions, connector accounts, credentials, skills, runtime activity, audit history, and related operator workflows.

The app is served by the Panda Control backend from `apps/control-ui/dist` when built locally. Historical PR1B rollout notes live in `docs/plans/2026-05-30-control-pr1b-ui.md`; verify operational behaviour against current code and CLI help.

## Development

From the repository root:

```bash
pnpm control:dev
pnpm control:typecheck
pnpm control:build
```

The CI gate for this package is:

```bash
pnpm ci:control-ui
```
