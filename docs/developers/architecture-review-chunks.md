# Architecture PR Review Chunks

Review this refactor as one PR with explicit review chunks. The worktree is
broad; the reviewer should not have to load it all at once.

## PR Review Order

1. Documentation, ADR, and public entrypoints
2. Session-owned delivery and wake routing
3. Runtime daemon, request drain, and app assembly boundaries
4. Postgres schema/store/row-parser split
5. Public gateway and micro-app surfaces
6. Channel worker lifecycle and connector delivery
7. Panda tools, browser, web, prompts, and kernel transcript cleanup
8. Tests, import-law ratchet, and stabilization notes

## Shared Ownership

- `package.json`: chunk 1 owns export-surface changes; chunk 8 owns architecture/import-law scripts.
- `src/app/cli.ts` and `src/app/cli-shared.ts`: chunk 1 owns CLI entrypoint wiring; chunk 5 owns gateway command assembly.
- `src/lib/postgres-*`: chunk 4 owns database, schema, query, transaction, relation, integrity, and value helpers.
- `src/lib/data-dir.ts` and `src/lib/health-server.ts`: chunk 3 owns the app-runtime helper demotion.
- `docs/developers/architecture.md`: chunk 1 owns source-lane descriptions; chunk 8 owns ratchet/stabilization rules.

## Single-PR Rule

- Open one PR for the architecture refactor.
- Structure the PR body with the eight chunks below.
- For each chunk, include the primary files, risk, and focused verification result.
- Keep review comments anchored to the chunk they belong to.
- Do not add unrelated cleanup while addressing review comments. New work goes into a follow-up unless it is needed to make the current PR safe.

## 1. Documentation, ADR, And Public Entrypoints

Intent: make the documented architecture match the shipped public surface.

Primary files:

- `docs/developers/README.md`
- `docs/developers/architecture.md`
- `docs/developers/adr/0001-runtime-architecture-guardrails.md`
- `docs/developers/a2a.md`
- `docs/developers/browser.md`
- `docs/developers/credentials.md`
- `docs/developers/email.md`
- `docs/developers/gateway.md`
- `docs/developers/sessions.md`
- `docs/developers/watches.md`
- `docs/developers/whatsapp.md`
- `docs/developers/wiki.md`
- deleted stale docs: `docs/developers/chat-vision.md`, `docs/developers/db-integrity-plan.md`, `docs/developers/restructure-plan.md`, `docs/developers/self-learning.md`
- `src/panda/index.ts`
- public API tests: `tests/package-exports.test.ts`, `tests/public-api-root.test.ts`, `tests/public-api-panda-persona.test.ts`

Review for:

- Source lanes match actual imports and package exports.
- Deleted docs are stale or superseded by the ADR, not merely inconvenient.
- Public exports do not leak old paths that no longer represent the architecture.

Keep out:

- Runtime behavior changes.
- Schema migrations.
- Public HTTP/security behavior.

Checks:

```sh
pnpm vitest run tests/package-exports.test.ts tests/public-api-root.test.ts tests/public-api-panda-persona.test.ts
git diff --check -- docs/developers package.json
```

## 2. Session-Owned Delivery And Wake Routing

Intent: delayed and external work follows sessions and resolves the current thread at fire/receive time.

Primary files:

- `src/domain/sessions/current-thread.ts`
- `src/domain/sessions/lifecycle.ts`
- `src/domain/sessions/types.ts`
- `src/domain/sessions/worker-metadata.ts`
- `src/domain/scheduling/heartbeats/runner.ts`
- `src/domain/scheduling/tasks/runner.ts`
- `src/domain/watches/runner.ts`
- `src/domain/watches/mutation-service.ts`
- `src/integrations/gateway/delivery.ts`
- `src/integrations/channels/email/sync-runner.ts`
- `src/app/runtime/daemon-requests.ts`
- `src/app/runtime/daemon-threads.ts`
- `src/prompts/runtime/email-events.ts`
- `src/prompts/runtime/watch-events.ts`

Review for:

- `session.currentThreadId` is the late-bound runtime target.
- Branch sessions are not treated as private ACL boundaries.

Keep out:

- Provider-specific parsing.
- Broad daemon lifecycle changes.

Checks:

```sh
pnpm vitest run tests/current-thread.test.ts tests/gateway-delivery.test.ts tests/email-sync-runner.test.ts tests/watch-runner.test.ts tests/scheduled-task-runner.test.ts tests/heartbeat-runner.test.ts
```

## 3. Runtime Daemon, Request Drain, And App Assembly Boundaries

Intent: app owns process orchestration; lower modules expose narrow stores and adapters.

Primary files:

- `src/app/runtime/client.ts`
- `src/app/runtime/create-runtime.ts`
- `src/app/runtime/daemon-bootstrap.ts`
- `src/app/runtime/daemon-lifecycle.ts`
- `src/app/runtime/daemon-requests.ts`
- `src/app/runtime/daemon-shared.ts`
- `src/app/runtime/daemon-threads.ts`
- `src/app/runtime/daemon-subagent-sessions.ts`
- `src/app/runtime/request-drain.ts`
- `src/app/runtime/runtime-bootstrap.ts`
- `src/app/runtime/thread-definition.ts`
- `src/app/runtime/subagent-session-service.ts`
- `src/app/runtime/subagent-purge-service.ts`
- `src/app/runtime/execution-environment-service.ts`
- `src/app/runtime/execution-environment-resolver.ts`
- `src/app/runtime/background-tool-thread-input.ts`
- `src/app/runtime/data-dir.ts`
- `src/app/runtime/database.ts`
- `src/app/runtime/postgres-bootstrap.ts`
- `src/app/health/server.ts`
- `src/lib/data-dir.ts`
- `src/lib/health-server.ts`
- `src/lib/drain-loop.ts`
- deleted app-runtime leftovers: `src/app/runtime/daemon-copy.ts`, `src/app/runtime/state/postgres-shared.ts`, `src/app/runtime/state/types.ts`
- tests: `tests/daemon-requests.test.ts`, `tests/daemon-lifecycle.test.ts`, `tests/daemon-threads.test.ts`, `tests/runtime-request-drain.test.ts`, `tests/subagent-session-service.test.ts`, `tests/subagent-purge-service.test.ts`, `tests/runtime-database.test.ts`, `tests/drain-loop.test.ts`, `tests/daemon-state-repo.test.ts`

Review for:

- The daemon remains the live orchestration boundary.
- Stores remain Postgres-backed; app runtime does not become a second persistence layer.
- Helpers moved out of `src/app` are genuinely generic.

Keep out:

- Store schema rewrites.
- Public HTTP admission behavior.

Checks:

```sh
pnpm vitest run tests/daemon-requests.test.ts tests/daemon-lifecycle.test.ts tests/daemon-threads.test.ts tests/runtime-request-drain.test.ts tests/subagent-session-service.test.ts tests/subagent-purge-service.test.ts tests/runtime-database.test.ts tests/drain-loop.test.ts tests/daemon-state-repo.test.ts
```

## 4. Postgres Schema, Store, And Row-Parser Split

Intent: DDL, row parsing, and store mutations have separate homes with migration safety.

Primary files:

- `src/lib/postgres-bootstrap.ts`
- `src/lib/postgres-database.ts`
- `src/lib/postgres-integrity.ts`
- `src/lib/postgres-listen.ts`
- `src/lib/postgres-query.ts`
- `src/lib/postgres-relations.ts`
- `src/lib/postgres-transaction.ts`
- `src/lib/postgres-values.ts`
- all changed `src/domain/**/postgres-schema.ts`
- all changed `src/domain/**/postgres-shared.ts`
- all changed Postgres stores under `src/domain/**/postgres.ts`, `src/domain/**/repo.ts`, and `src/domain/**/postgres-rows.ts`
- `src/domain/gateway/postgres-rows.ts`
- `src/domain/threads/runtime/postgres-lease.ts`
- `src/domain/threads/runtime/postgres-notifications.ts`
- tests: `tests/agents-postgres.test.ts`, `tests/app-auth-postgres.test.ts`, `tests/channel-cursors-postgres.test.ts`, `tests/conversation-sessions-postgres.test.ts`, `tests/credentials-postgres.test.ts`, `tests/email-postgres.test.ts`, `tests/execution-environments-postgres.test.ts`, `tests/gateway.test.ts`, `tests/identity-postgres.test.ts`, `tests/runtime-requests.test.ts`, `tests/scheduled-tasks-postgres.test.ts`, `tests/session-routes-postgres.test.ts`, `tests/sessions-postgres.test.ts`, `tests/thread-runtime-postgres.test.ts`, `tests/thread-lease-postgres.test.ts`, `tests/watches-postgres.test.ts`, `tests/wiki-bindings-postgres.test.ts`, `tests/db-integrity-postgres.test.ts`

Review for:

- `postgres-schema.ts` owns DDL, repair migrations, and cross-table constraints.
- Row decoding rejects malformed persisted state at the repo boundary.
- Store methods keep mutation/query behavior readable.
- Backfill and repair migrations are idempotent and safe for deployed databases.

Keep out:

- Public HTTP behavior.
- Connector protocol behavior.

Checks:

```sh
pnpm vitest run tests/db-integrity-postgres.test.ts tests/scheduled-tasks-postgres.test.ts tests/watches-postgres.test.ts tests/thread-runtime-postgres.test.ts tests/thread-lease-postgres.test.ts tests/runtime-requests.test.ts tests/gateway.test.ts tests/credentials-postgres.test.ts tests/app-auth-postgres.test.ts tests/wiki-bindings-postgres.test.ts tests/email-postgres.test.ts tests/session-routes-postgres.test.ts tests/sessions-postgres.test.ts
```


## 5. Public Gateway And Micro-App Surfaces

Intent: public and semi-public edges stay small, explicit, and security-reviewable.

Primary files:

- `src/app/gateway/cli.ts`
- `src/domain/gateway/cli.ts`
- `src/integrations/gateway/http.ts`
- `src/integrations/gateway/http-body.ts`
- `src/integrations/gateway/http-config.ts`
- `src/integrations/gateway/event-request.ts`
- `src/integrations/gateway/request-admission.ts`
- `src/integrations/gateway/network-controls.ts`
- `src/integrations/gateway/oauth-token.ts`
- `src/integrations/gateway/event-acceptance.ts`
- `src/integrations/gateway/guard.ts`
- `src/integrations/gateway/guard-policy.ts`
- `src/integrations/gateway/worker.ts`
- `src/integrations/http-body.ts`
- `src/integrations/apps/http-api.ts`
- `src/integrations/apps/http-auth.ts`
- `src/integrations/apps/http-body.ts`
- `src/integrations/apps/http-config.ts`
- `src/integrations/apps/http-errors.ts`
- `src/integrations/apps/http-launch.ts`
- `src/integrations/apps/http-rate-limit.ts`
- `src/integrations/apps/http-routes.ts`
- `src/integrations/apps/http-runtime.ts`
- `src/integrations/apps/http-sdk.ts`
- `src/integrations/apps/http-security-headers.ts`
- `src/integrations/apps/http-server.ts`
- `src/integrations/apps/http-static.ts`

Review for:

- Body admission is strict and size bounded.
- Trusted proxy and IP allowlist behavior is explicit.
- App links expose launch tokens, not raw identity/session ids.
- Public error responses avoid raw structured payloads; do not rely on lexical token redaction for privacy.

Keep out:

- Private TUI behavior.
- Non-public negative-code cleanup.

Checks:

```sh
pnpm vitest run tests/gateway-http-body.test.ts tests/gateway-event-request.test.ts tests/gateway-network-controls.test.ts tests/gateway-http-config.test.ts tests/app-http-body.test.ts tests/app-http-runtime.test.ts tests/app-server.test.ts tests/app-service.test.ts
```

## 6. Channel Worker Lifecycle And Connector Delivery

Intent: shared worker lifecycle is boring; protocol behavior stays local.

Primary files:

- `src/domain/channels/actions/*`
- `src/domain/channels/cursors/*`
- `src/domain/channels/deliveries/*`
- `src/domain/channels/media-store.ts`
- `src/domain/channels/outbound.ts`
- `src/domain/channels/route-target.ts`
- `src/domain/channels/types.ts`
- `src/domain/channels/typing.ts`
- `src/domain/channels/worker-shared.ts`
- `src/domain/connector-leases/repo.ts`
- `src/domain/connector-leases/postgres-schema.ts`
- `src/integrations/channels/worker-runtime.ts`
- `src/integrations/channels/inbound-delivery.ts`
- `src/integrations/channels/postgres-notification-listener.ts`
- `src/integrations/channels/a2a/*`
- `src/integrations/channels/email/outbound.ts`
- `src/integrations/channels/media-shared.ts`
- `src/integrations/channels/telegram/*`
- `src/integrations/channels/tui/*`
- `src/integrations/channels/whatsapp/*`
- tests: `tests/channel-worker-runtime.test.ts`, `tests/channel-worker-notification-listener.test.ts`, `tests/channel-actions.test.ts`, `tests/outbound-deliveries.test.ts`, `tests/telegram-service.test.ts`, `tests/telegram-cli.test.ts`, `tests/telegram-message-ingestion.test.ts`, `tests/telegram-media.test.ts`, `tests/telegram-reactions.test.ts`, `tests/whatsapp-runtime-cycle.test.ts`, `tests/whatsapp-connection.test.ts`, `tests/whatsapp-health.test.ts`, `tests/whatsapp-message-ingestion.test.ts`, `tests/whatsapp-media.test.ts`, `tests/whatsapp-pairing.test.ts`, `tests/whatsapp-socket.test.ts`, `tests/whatsapp-cli.test.ts`

Review for:

- Worker lifecycle is wake/drain driven, not a hot loop.
- Telegram and WhatsApp keep protocol details in their own adapters.
- Shared channel helpers do not become a generic connector framework.
- A2A uses `a2a.send`; human/channel outbound uses provider-specific send commands.

Keep out:

- Session-current-thread policy except at the ingress callsite.
- Public gateway behavior.

Checks:

```sh
pnpm vitest run tests/channel-worker-runtime.test.ts tests/channel-worker-notification-listener.test.ts tests/channel-actions.test.ts tests/outbound-deliveries.test.ts tests/telegram-service.test.ts tests/telegram-cli.test.ts tests/telegram-message-ingestion.test.ts tests/telegram-media.test.ts tests/telegram-reactions.test.ts tests/whatsapp-runtime-cycle.test.ts tests/whatsapp-connection.test.ts tests/whatsapp-health.test.ts tests/whatsapp-message-ingestion.test.ts tests/whatsapp-media.test.ts tests/whatsapp-pairing.test.ts tests/whatsapp-socket.test.ts tests/whatsapp-cli.test.ts
```

## 7. Panda Tools, Browser, Web, Prompts, And Kernel Transcript Cleanup

Intent: model-facing surfaces are compact, provider-neutral kernel code stays below domain, and deleted scaffolding stays deleted.

Primary files:

- `src/kernel/transcript/types.ts`
- `src/kernel/transcript/compaction.ts`
- `src/kernel/transcript/inference-projection.ts`
- `src/kernel/agent/thread.ts`
- `src/kernel/agent/tool.ts`
- `src/kernel/agent/types.ts`
- `src/kernel/agent/helpers/*`
- `src/kernel/models/model-context-policy.ts`
- `src/panda/contexts/*`
- `src/panda/tools/*`
- `src/domain/subagents/tool-groups.ts`
- `src/panda/subagents/service.ts`
- `src/integrations/browser/*`
- `src/integrations/web/*`
- `src/integrations/wiki/*`
- `src/prompts/channels/*`
- `src/prompts/runtime/*`
- deleted tool/browser leftovers: `src/panda/prompt.ts`, `src/panda/tools/browser-output.ts`, `src/panda/tools/browser-schema.ts`, `src/panda/tools/browser-service.ts`, `src/panda/tools/browser-snapshot.ts`, `src/panda/tools/browser-types.ts`, `src/panda/tools/http.ts`, `src/panda/tools/safe-web-target.ts`, `src/panda/tools/web-fetch.ts`, `src/panda/tools/web-research.ts`, `src/domain/subagents/tool-groups.ts`, `src/kernel/agent/abort.ts`, `src/kernel/transcript/message-preview.ts`
- tests: `tests/thread.test.ts`, `tests/thread-runtime.test.ts`, `tests/provider-runtime.test.ts`, `tests/browser-tool.test.ts`, `tests/browser-runner.test.ts`, `tests/browser-protocol.test.ts`, `tests/web-fetch-command.test.ts`, `tests/web-research-command.test.ts`, `tests/wiki-command-service.test.ts`, `tests/tool-format.test.ts`, `tests/tool-shared.test.ts`, `tests/subagent-spawn-command.test.ts`, `tests/media-tool.test.ts`, `tests/command-modules.test.ts`, `tests/command-dispatcher.test.ts`

Review for:

- Kernel no longer imports domain transcript/runtime types.
- Panda tools depend on narrow interfaces, not app service classes.
- Prompt text lives under `src/prompts`.
- Browser/web helpers are integration code, not model-facing tool clutter.

Keep out:

- Daemon lifecycle changes.
- Public HTTP security behavior unless the file is listed in chunk 5.

Checks:

```sh
pnpm vitest run tests/thread.test.ts tests/thread-runtime.test.ts tests/provider-runtime.test.ts tests/browser-tool.test.ts tests/browser-runner.test.ts tests/browser-protocol.test.ts tests/web-fetch-command.test.ts tests/web-research-command.test.ts tests/wiki-command-service.test.ts tests/tool-format.test.ts tests/tool-shared.test.ts tests/subagent-spawn-command.test.ts tests/media-tool.test.ts tests/command-modules.test.ts tests/command-dispatcher.test.ts
```

## 8. Tests, Import-Law Ratchet, And Stabilization Notes

Intent: make the cleanup enforceable and keep low-value tests from coming back.

Primary files:

- `scripts/import-law-report.mjs`
- `scripts/import-law-baseline.json`
- `package.json`
- `architecture-next-steps-todo.md`
- `stabilization-and-ratcheting-todo.md`
- this file
- deleted or replaced tests, especially shallow wiring-only tests
- behavior-focused replacements under `tests/*`

Review for:

- `pnpm architecture:import-law` remains a readable report.
- `pnpm architecture:import-law:ratchet` fails on new violations.
- Baseline entries are shrinking or explicitly transitional.
- Deleted tests asserted little or were replaced by behavior tests.

Keep out:

- New production behavior unless it belongs to a prior chunk.

Checks:

```sh
pnpm architecture:import-law
pnpm architecture:import-law:ratchet
pnpm typecheck
git diff --check
```

## Chunk Discipline

- One PR contains all chunks, but each review pass should cover one chunk unless the files are mechanically coupled.
- Keep public-surface, Postgres migration, and negative-code cleanup separate.
- If a file appears in two chunks, use the shared ownership section above to decide the primary reviewer.
- For each chunk, paste the focused check command into the PR body with the result.
- If a follow-up is real but not needed for this branch, add it to `architecture-next-steps-todo.md` instead of smuggling it into an unrelated patch.
