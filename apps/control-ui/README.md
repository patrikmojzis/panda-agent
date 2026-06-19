# Panda Control UI

Panda Control UI is the React/Vite operator console for Panda Agent. It provides authenticated Control screens for agents, sessions, connector accounts, credentials, skills, runtime activity, audit history, and related operator workflows.

The app is served by the Panda Control backend from `apps/control-ui/dist` when built locally. See `docs/control-pr1b-ui.md` for the full Control server setup and token-login flow.

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
