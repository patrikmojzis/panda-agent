# Control vs Panda CLI coverage

This audit maps Panda CLI command groups to current Control UI/API coverage on
`origin/main` (`9d60016`). Update it whenever `src/app/cli.ts` registers a new
command group or Control adds/removes operator surfaces.

## Stance keys

- **A**: Control follow-up is appropriate and should be scoped explicitly.
- **B**: Docs, diagnostics, or source-verified matrix only; no product work here.
- **C**: Intentionally CLI/deployment/admin-only; do not add a generic UI button.
- **D**: Deprecated or archaeology/deprecation candidate.

## Source anchors

CLI registration starts in `src/app/cli.ts`, then delegates to `src/app/*/cli.ts`,
`src/domain/*/cli.ts`, `src/integrations/channels/*/cli.ts`, and
`src/ui/observe/cli.ts`. Control coverage claims cite
`apps/control-ui/src/app/control-routes.ts`, `apps/control-ui/src/lib/api.ts`,
`src/integrations/control/http-server.ts`, and
`src/domain/control/operator-service.ts`.

## Coverage matrix

| CLI command group | Current Control coverage | Stance |
| --- | --- | --- |
| Default chat, `chat`, `observe`, `smoke` (`src/app/cli.ts`, `src/ui/observe/cli.ts`, `src/app/smoke/cli.ts`) | No Control UI equivalent; these are TUI/activity/smoke diagnostics. | **B** diagnostics/dev workflows stay documented, not product UI. |
| Runtime/process entrypoints: `run`, `gateway run`, channel `run`, `bash-server`, `runner`, `browser-runner`, `environment-manager` (`src/app/cli.ts`, `src/app/gateway/cli.ts`, channel CLIs) | Control reads and edits stored config, but does not start long-running processes. | **C** lifecycle/process management stays CLI/deployment. |
| Runner targets: `runner attach`; `session targets list/status/bind/detach` (`src/app/cli.ts`, `src/domain/sessions/cli.ts`) | Runtime tab and API methods in `apps/control-ui/src/app/control-routes.ts` and `apps/control-ui/src/lib/api.ts`; HTTP/operator backing in `src/integrations/control/http-server.ts` and `src/domain/control/operator-service.ts`. | **A/C**: improve visible target setup/status plus CLI handoff in the remote runner shared-secret/setup follow-up (#211); process launch/secrets remain CLI-only. |
| Agents, identities, and Control grants: `agent list/create/ensure/pair/unpair/pairings`, `identity list/create`, `control grant` | Agent/identity nav and agent access tab in `control-routes.ts`; list/create identity, pair/unpair, and grant APIs in `api.ts`; HTTP/operator handlers in `http-server.ts` and `operator-service.ts`. No Control agent-create API on current main. | **B/A/C**: list/pair/grant and identity create are covered; `agent create` needs a scoped create-agent setup UX follow-up; `agent ensure` remains bootstrap/scaffold repair CLI. |
| Sessions: `session create/list/label/inspect/reset`, `session prompt *`, `session heartbeat`, `session bind-conversation`, `a2a *` | Session tabs for Prompts/Runtime/A2A/Bindings in `control-routes.ts`; session, prompt, heartbeat, binding, reset, and A2A APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`. | **B** covered; matrix only. |
| Credentials and wiki: `credentials set/clear/list/resolve`; `wiki binding set/show/clear` | Credentials and Wiki tabs in `control-routes.ts`; credential/wiki APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`. | **B**: set/clear/list/wiki are covered; `credentials resolve` is a redacted diagnostic only. |
| Generic connector accounts: `connector account list/inspect/enable/disable` | Connectors tab in `control-routes.ts`; connector list/upsert/status APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`. Control forms cover supported sources (Discord, email, Telegram); raw inspect remains diagnostic. | **B** supported-source setup/status is covered; inspect is diagnostic. |
| Telegram: `telegram account set/whoami/import-env/disable`, `telegram pair/unpair`, `telegram whoami`, `telegram run` | Telegram connector setup/status and actor pairings in `api.ts`; connector/pairing handlers in `http-server.ts` and `operator-service.ts`; connector panel UI under Control uses these APIs. | **B/C/D**: setup/pairing covered; `whoami` is diagnostic; `run` is process lifecycle (**C**); `import-env` is legacy import helper (**D**, #232). |
| Discord: `discord account set/whoami/import-env/disable`, `discord pair/unpair/pairings`, `bind-channel`/`unbind-channel`/`bindings list`, `discord run` | Discord connector, actor pairing, and conversation binding APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`; connector panel UI uses them. | **A/B/C/D**: setup/pairing/bindings are covered; add #229 checklist/whoami diagnostic polish; raw `whoami` is diagnostic; `run` is process lifecycle (**C**); `import-env` is archaeology (**D**, #232). |
| WhatsApp: `whatsapp link/whoami/pair/unpair/run` | Telegram/WhatsApp actor pairings share Control APIs in `api.ts`, `http-server.ts`, and `operator-service.ts`; no full WhatsApp account-link UI on current main. | **A/B/C**: #230 should decide minimal inspect/link stance; `whoami` is diagnostic, `link` likely CLI handoff, and `run` remains process lifecycle. |
| Email: `email account set/disable`, `email allow add/remove/list`, `email route set/remove/list` | Email connector, route, and allowlist APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`; connector panel UI exposes account/route/allowlist flows. | **B** covered; matrix only. |
| Gateway safe setup and inspection: `gateway source create/list/allow-type/disallow-type/rotate-secret/suspend/resume`, `gateway device register/list/enable/disable/rotate-token`, `gateway event-list` | Gateway tab and session gateway tab in `control-routes.ts`; source/device/event-type/event APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`. | **B** covered setup/inspection flows only; one-time source/device secrets stay guarded/audited. Control device registration is an upsert and can return a new one-time token for an existing device; the command mailbox is not a generic setup button. |
| Gateway device command queue and maintenance: `gateway device command enqueue/list/cancel/timeout-sweep --source <sourceId> --stale-ms <ms>`, `gateway attachment-scrub-expired` | No direct Control queue list/mutation, timeout-sweep, attachment scrub, or gateway process route. Control Home may show sanitized `gateway_device_command` failure summaries, which is diagnostic and not queue maintenance. | **C**: queue mutation/listing, expired-attachment cleanup, process lifecycle, and raw maintenance remain CLI-only by default; future Control exposure needs a focused audited operator UX. |
| Subagents: `subagents profiles list/get/upsert/disable`, `subagents purge` | Subagents tab in `control-routes.ts`; list/get/set/enable APIs in `api.ts`; handlers/services in `http-server.ts` and `operator-service.ts`. | **B/C**: profile CRUD is covered; hard purge remains CLI-only destructive maintenance. |
| OpenClaw importer, old runner aliases, and env import helpers | No OpenClaw command is registered on current `src/app/cli.ts`. Old `RUNNER_*` aliases hard-fail in `scripts/run-docker-runner.sh`/docs; Telegram/Discord `account import-env` helpers still exist. | **D** archaeology/deprecation candidate (#232); do not expand Control for these helpers. |
