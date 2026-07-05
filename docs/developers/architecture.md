# Panda Architecture

Panda should be organized by role in the system, not by "stuff we share sometimes."

The decisions that future architecture work should not casually reopen live in
[ADR 0001: Runtime Architecture Guardrails](./adr/0001-runtime-architecture-guardrails.md).

The target buckets are:

- `app`: entrypoints, process lifecycle, runtime assembly, CLI wiring
- `kernel`: the inner agent loop and provider-neutral execution primitives
- `prompts`: editable model-facing text, wrappers, and default templates
- `panda`: Panda persona pack, tool policy, contexts, and subagent wiring
- `domain`: business concepts like agents, identity, threads, scheduling, and channel records
- `integrations`: external systems like providers, Telegram, WhatsApp, Postgres, shell
- `ui`: terminal and other human-facing surfaces
- `lib`: small low-level helpers and generic local adapters that do not depend on Panda app assembly

## Import Law

Keep the dependency direction boring.

- `lib` imports nothing project-specific
- `prompts` should stay mostly strings-in, strings-out; `lib` imports are fine, and tiny type-only `domain` imports are acceptable when they keep contracts honest
- `kernel` may import `prompts`, `lib`, and provider-shared model/runtime glue while that glue still lives under `integrations/providers/shared`
- `domain` may import `kernel`, `prompts`, and `lib`; domain CLI files use `lib` bootstrap helpers and leave daemon/process assembly to `app`
- `integrations` may import `domain`, `kernel`, `prompts`, and `lib`
- `panda` may import `domain`, `kernel`, `integrations`, `prompts`, `lib`, and narrow app runtime context types/helpers
- `ui` may import `app`, `panda`, `domain`, `kernel`, and `lib`
- `app` may import anything

If a lower layer needs something from a higher layer, that is a design smell, not a cute exception.

Run `pnpm architecture:import-law` to inspect current dependency-direction
violations. Run `pnpm architecture:import-law:ratchet` before merge; it allows
only the explicit entries in `scripts/import-law-baseline.json`, which should
normally stay empty. After a cleanup chunk removes violations, update the baseline with
`node scripts/import-law-report.mjs --update-baseline` so the ratchet keeps
shrinking instead of normalizing old damage.

CI runs the same ratchet in
`.github/workflows/ci.yml`. A PR that adds a new dependency
direction violation should fail there even if the report-only command still
prints a readable local report.

## Bucket Rules

### `app`

Put startup and orchestration here.

- CLI entrypoints
- daemon bootstrap
- runtime composition
- process shutdown handling

Do not hide core logic here. `app` should wire parts together, not become the product.
For Panda runtime assembly, keep the public facade thin:

- `create-runtime.ts` is the public entry
- `database.ts` re-exports generic DB URL/pool helpers for compatibility; new callers use `src/lib/postgres-database.ts`
  Postgres pool observation depends on `ObservablePostgresPool`: stats,
  `connect`, `query`, and error listeners. Do not make observer tests fake a
  full `pg.Pool`.
- `thread-definition.ts` owns stored-context recovery and Panda thread definition shaping
- `runtime-bootstrap.ts` is internal wiring glue, not package API
- `daemon-lifecycle.ts` exposes `DaemonLifecycleContext`, the runtime/worker
  method slice the lifecycle actually uses. Do not make lifecycle tests or
  helpers assemble the full bootstrap `DaemonContext`.
- `request-drain.ts` owns runtime request queue draining; daemon lifecycle only arms and stops it
- `state/repo.ts` owns daemon heartbeat state parsing; lifecycle code should not
  consume raw daemon-state timestamps, stringified timestamp leftovers, or blank
  daemon keys
  Keep daemon-state record and table-name details local to that repo unless a
  second module truly needs the same interface.
- `daemon-subagent-sessions.ts` owns daemon subagent-session request mapping.
  `daemon-threads.ts` should coordinate thread/session commands, not inline
  subagent handoff policy.
- `daemon-threads.ts` exposes a narrow `DaemonThreadHelperContext` method slice.
  Tests and callers should not need to assemble a full daemon context just to
  exercise thread/session command behaviour.
- `daemon-requests.ts` exposes `DaemonRequestProcessorContext` and
  `DaemonRequestThreadHelpers` slices. Runtime request dispatch should depend on
  the stores/coordinator/helper methods it calls, not on the full daemon
  bootstrap context.
  Its thread store seam is intentionally small: thread lookup/update, runnable
  checks, and compaction transcript load/append. Do not re-expand it to the full
  runtime store for request handlers.
- `execution-environment-resolver.ts` owns default environment resolution and
  should depend only on default-binding/environment lookup plus the optional
  lifecycle recovery seam. It should not require the full execution-environment
  repository surface.
- `execution-environment-service.ts` owns lifecycle mutations: create/bind/get
  environment, read default binding, and sweep expired disposable environments.
  It should not depend on schema setup or context-listing methods.
  Execution-environment credential, skill, and tool allowlists are normalized at
  the store seam; callers should not trim or filter policy entries themselves.
- `subagent-purge-service.ts` owns hard deletion planning and DB/file cleanup for
  disposable subagents. It may stop environments through the narrow
  `stopExecutionEnvironment` seam, but purge planning must not depend on the
  full execution-environment repository.
- `subagent-session-service.ts` owns subagent session/thread creation, environment
  binding, and initial handoff enqueueing. Its store seam should require only
  session create/get and thread create/get/enqueue methods; Postgres transaction
  cleanup stays behind the optional pool fast path.

### `kernel`

This is the engine room.

- thread loop
- run pipeline
- tool contract
- hook contract
- context contract
- provider-neutral runtime types

Keep `kernel` boring and reusable. No Postgres. No Telegram. No Panda persona details. No process env policy.
Provider-specific adapters still stay out of the kernel; only the shared model/runtime glue is tolerated here until that boundary moves.
Tool parameter formatting in `src/kernel/agent/helpers/schema.ts` must validate
Zod's JSON Schema output as a JSON object. Do not cast schema output straight
into the provider/tool contract.
Model/tool content text extraction lives in
`src/kernel/agent/helpers/message-text.ts`; gateway guards, compaction, tools,
and subagents should not clone provider-neutral text-block filtering.

### `prompts`

This is the editable text layer.

Put here:

- system prompt text
- synthetic wake and scheduled-task prompt renderers
- channel wrapper text
- context dump wrappers
- default agent-doc templates

Keep it dumb.
Data in, string out.
No DB reads. No env probing. No shell calls. No side effects.

### `panda`

`panda` is the default configured brain, not the runtime.

Put here:

- prompt composition and persona defaults
- tool selection and policy
- persona contexts
- subagent policy

Do not bury giant prompt literals here.
If the wording itself is what you are editing, it probably belongs in `src/prompts`.
Do not add pass-through prompt modules under `src/panda`; public Panda exports
should re-export prompt constants from `src/prompts` directly.

Do not put daemon wiring, DB pool setup, or connector boot code here.
Durable subagent creation is runtime wiring: `SpawnSubagentTool` should depend on
a narrow `SubagentSessionCreator` seam, and `SubagentSessionService` owns durable
session/thread/A2A handoff creation. Subagent profiles and tool groups are the
policy source of truth; do not add model-facing raw tool/skill allowlists or
role-specific compatibility wrappers.
Agent profile context should depend on the `AgentProfileStore` read slice,
because prompt/skill context rendering should not require mutation or pairing
methods from the agent store.
Agent prompt and skill tools should depend on their own prompt/skill store
slices, not the full agent store. Model-facing tools should not inherit pairing,
bootstrap, or listing powers they do not use.
Model-facing tools should read runtime session scope through
`src/panda/tools/shared.ts`. Do not import path-resolution helpers just to read
`agentKey`, `sessionId`, or current input ids.
Watch tools should depend on local create/update and disable store slices.
The model-facing create/update/disable tools should not force tests or callers
to fake the full watch runner/store surface, and those slices should not become
exported seams unless another module genuinely consumes them.
`WatchMutationService` should likewise depend on its create/get/update method
slice, not the full runner-facing `WatchStore`; watch mutation tests should not
need claim/run/event methods they never exercise.
`WatchRunner` should depend on the complementary runner method slice: due-watch
listing, claim/run status, and event recording. It should not carry
create/update/disable/admin watch methods through its interface.

### `domain`

This is Panda's actual business model.

Put here:

- agents
- identity
- sessions
- threads
- scheduling
- channels, deliveries, and queue semantics

This layer owns names and concepts. It should not know how Telegram polls or how Anthropic formats a request.
Postgres stores and schema helpers should type only the database seam they
use: query-only code takes a structural queryable, transaction code adds
`connect`/`release`, and LISTEN code adds `on`/`off`. Do not force tests to
cast fake pools into full `pg.Pool`/`PoolClient` shapes.
Generic Postgres pool/client/queryable types come from `src/lib/postgres-query.ts`,
not from the thread runtime transaction helper.
Generic Postgres transaction wrappers come from
`src/lib/postgres-transaction.ts`; transaction control is not a thread runtime
concept.
Generic Postgres pool and CLI bootstrap helpers come from
`src/lib/postgres-database.ts` and `src/lib/postgres-bootstrap.ts`; domain,
integration, and model-facing modules should not import app runtime just to open
a pool or ensure schemas.
Generic Postgres schema/identifier/relation-name helpers come from
`src/lib/postgres-relations.ts`, not from any domain store's local
`postgres-shared.ts`.
Single-channel Postgres `LISTEN` consumers should go through
`src/lib/postgres-listen.ts`; keep custom listener code only when one client
must manage multiple channels or extra connection events.
Keep domain Postgres code split by responsibility:

- `*-schema.ts` files own DDL, migrations, and integrity preflights.
- Store/repo files own row mutation, lookup, and row-to-domain parsing.
- Row parser modules are justified only for large public or shared tables.
- Shared table-name builders live in `postgres-shared.ts`; schema files should
  not re-export pass-through `buildPostgres*TableNames()` wrappers when a shared
  builder already exists.
- Primitive row validation should use the boring shared helpers in `src/lib`
  (`booleans`, `numbers`, `strings`, `json`, and Postgres timestamp validators
  in `postgres-values`) instead of growing per-store parser clones.
  Use `requireTrimmedString` when a parser must preserve separate type and
  empty-value diagnostics; use `requireNonEmptyString` when one caller-owned
  error message is enough.
  For optional strings, use `optionalTrimmedString` when blank means absent but
  non-string persisted values are invalid; use `optionalNonEmptyString` when
  blank persisted values are invalid too.
  Domain-specific row helpers may wrap them to attach a concept name, but should
  not reimplement trimming, nullability, or timestamp conversion.
- Generic Postgres row-value conversion helpers, such as timestamp and JSONB
  parameter conversion, live in `src/lib/postgres-values.ts`; domain stores
  should not import them from thread runtime modules.
- Generic data-dir and health-server helpers live in `src/lib/data-dir.ts` and
  `src/lib/health-server.ts`. Lower modules should import those directly; app
  runtime re-exports exist only for compatibility and app assembly.
- Runtime code should receive domain records, not raw JSONB, enum casts, driver
  truthiness, or stringified timestamp leftovers.
- Thread transcript row parsing must reject unsupported persisted message
  roles before replay. Keep that boundary compatibility-light: validate the
  durable role invariant without freezing provider-specific message payloads.

Session is the durable wake anchor. Scheduled tasks, watches, channel routing,
A2A bindings, subagent handoff, and gateway delivery must resolve the session's
current thread at the point where they enqueue or record work. Public ingress
must reserve/claim durable state before resolving the current thread, so `/reset`
cannot deliver to a stale backing thread.
Claimed session-owned work must also settle its own claim locally. Runners that
claim scheduled tasks, watches, or heartbeats own the complete/skip/fail policy
for that claim, including current-thread resolution failures. Do not leave those
failures to outer error logging or TTL expiry.

Their stores must parse persisted state before decryption, public delivery,
token issuance, or device/session trust decisions. Privacy belongs in scoped DB
roles and constrained views, not prompt instructions.
Credential decryption sits behind the `CredentialResolver`/`CredentialService`
module seam. That seam depends on the credential read/write method slices it
uses, not on the concrete Postgres store, so tools and channel adapters can test
credential behaviour without faking persistence internals.
Wiki binding token decryption follows the same rule: `WikiBindingService`
depends on get/set/delete binding methods, not on the concrete Postgres adapter.

Narrow store slices are preferred when workers/tools need only a few methods.
Do not make tests or adapters fake a whole store/service when a runner needs
only lookup, mutation, or credential resolution.

### `integrations`

Anything that touches the outside world lives here.

Put here:

- model providers
- Telegram, WhatsApp, email, A2A, and gateway adapters
- browser, apps, wiki, and watch source adapters
- shell and remote runner glue

Keep API-specific payload shaping here. Do not leak it into the thread loop.
Split integration code only when the new module owns a real boundary: external
protocol parsing, auth/security policy, byte limits, filesystem safety,
provider quirks, socket lifecycle, or deterministic channel/media shaping.
Do not create one-file indirection for a helper that has one caller and no
boundary of its own.
Server/dispatcher modules should not re-export config helpers; import config
from the config module so HTTP routing, env parsing, and tests keep separate
seams.

Validate external JSON, runner responses, provider payloads, app action output,
and model-visible tool details before they cross into `domain`, `kernel`, or
`panda`. Browser, shell, provider, gateway, app, wiki, and channel adapters
should return typed records or guarded JSON, not arbitrary response objects.
Integration-owned tools should depend on narrow context slices for the fields
they use. Do not import Panda's app-level `DefaultAgentSessionContext` into
integration modules just to read current input metadata or queue one action.

Public surfaces are security-sensitive:

- Gateway owns trusted-proxy/IP allowlist, OAuth/token parsing, event budgets,
  idempotency, guard policy, and delivery reservation before wake.
- Micro-app HTTP owns route normalization, cookies, CSRF, security headers,
  rate limits, body limits, JSON object validation, SDK/bootstrap shaping, and
  SQLite escape hatches.
  Public app URL and cookie-locality checks must use `src/lib/http.ts`
  hostname normalization instead of cloning loopback rules.
  Panda-owned app HTML templates should escape through
  `src/integrations/apps/html.ts`; do not clone ad hoc entity replacement in
  scaffold or launch pages.
  Public app API/runtime code shares the `AgentAppSessionContextStore` seam:
  explicit-session lookup plus main-session fallback only. Do not hand public
  app routes a mutation-capable session store.
  App scaffold result shapes should expose facts callers can use, not constant
  success flags. The observable contract is the created app definition, written
  file paths, schema application state, and the actual database file.
- Web fetch/watch HTTP owns URL protocol checks, private-address blocking, DNS
  pinning, redirect validation, byte limits, and credential-header privacy
  across redirects.
- Channel adapters own provider-specific command parsing, media/reaction policy,
  socket/polling lifecycle, and worker lease choreography.
  WhatsApp pairing depends on the small auth-promotion seam it uses: account
  creds plus `promoteTo`. Do not require the full auth-state handle in pairing
  code or tests.
  Shared channel worker notification filtering lives in
  `src/integrations/channels/postgres-notification-listener.ts`; provider
  services should only supply source, connector key, workers, and their
  health/error reaction.
- Channel config modules own channel-specific env parsing and constants. Generic
  runtime paths come from `app/runtime/data-dir.ts`, not channel-specific
  pass-through aliases.

Session-owned inbound work must target sessions, then resolve the current
thread at delivery time. The durable route/session state must be written before
`submitInput`, and wake callbacks should carry `sessionId`, not captured
`SessionRecord` objects.
`src/domain/sessions/current-thread.ts` owns this delivery seam for both live
wakes and queued inputs; callers should not open-code current-thread lookup
next to `submitInput` or `enqueueInput`.

Runtime request records are discriminated by `kind`; each kind owns exactly one
payload shape in `src/domain/threads/requests/types.ts`. Daemon dispatch should
narrow by kind instead of casting payloads by hand.

### `ui`

Human-facing surfaces.

- TUI rendering
- chat commands
- view formatting

The UI can talk to the app layer, but it should not become the runtime source of truth.
UI runtime services should expose read-shaped thread store slices, not the full
mutation-capable runtime store. Chat and observe surfaces need snapshots,
transcripts, and run lists; daemon requests own mutation.

### `lib`

`lib` is for tiny, pure, boring helpers.

- text helpers
- time helpers
- ids
- collections
- formatting
- parsing

If a file touches Postgres, process env, channels, providers, threads, or persona state, it does not belong in `lib`.

When a tiny helper starts showing up in multiple files, stop cloning it.

- Put pure cross-cutting helpers in focused `src/lib/*` files like `strings.ts`, `records.ts`, `numbers.ts`, `json.ts`, `http.ts`, or `dates.ts`.
- Promise/timer helpers that are not tied to a domain concept live in
  `src/lib/async.ts`; background job modules should not clone fallback-timeout
  loops.
- If the helper is only shared inside one subsystem, keep it next to that subsystem in a narrow `shared.ts` file instead of inventing a global dependency.
- Do not add a catch-all `utils.ts` or `shared.ts` at repo root. That is just a junk drawer with better PR.
- Canonical `JsonValue`/`JsonObject` types live in `src/lib/json.ts`; higher
  layers may re-export them for compatibility, but domain and integration code
  should import plain JSON types and guards from `src/lib/json.ts`, not from the
  kernel.
- Cross-cutting runtime/source value normalization to JSON also belongs in
  `src/lib/json.ts`; adapters should not hide their own BigInt, Date, Buffer,
  or ObjectId JSON coercion when the behavior is reusable.
- HTTP hostname normalization and loopback checks live in `src/lib/http.ts`;
  public transports should not clone their own localhost allow rules.
- Opaque bearer/launch/device token generation, storage hashing, and timing-safe
  hash comparison live in `src/lib/opaque-tokens.ts`; gateway, public app auth,
- Filesystem-safe path segment guards and label normalization live in
  `src/lib/path-segments.ts`; subsystem modules should keep their own error
  wording but reuse the same path-safety rule.
- Shared numeric shape checks, including TCP port range parsing, live in
  `src/lib/numbers.ts`; listener config modules should keep local error wording
  without cloning the integer/range predicate.
- New shared helpers should carry short doc comments so the next person knows why they exist and when to reuse them.

## Explicit Calls

These are not "maybe later" ideas. They are structure rules.

- No top-level `common`. It will become a junk drawer.
- Kill `pi` as a folder name. It says nothing.
- Keep barrel files only at real public boundaries.
- Do not promote code to shared/global just because two files use it.
- Do not retype tiny helpers like `isRecord`, string trimming, truncation, JSON/http helpers, or simple validators. Search `src/lib` and the local subsystem first.
- Reused "trim, drop blanks, and dedupe" string-list behavior belongs in
  `uniqueTrimmedStrings`; do not reopen-code it with ad hoc `Set` pipelines.
- Do not hide long prompt text inside runners, helpers, or services.
- Prefer fewer files when an abstraction is fake.
- Long-lived poll/notification workers should reuse the shared drain loop
  instead of cloning timer, single-flight drain, pending rerun, and stop-wait
  logic in each runner.
- Daemon lifecycle should not inline runtime request queue draining. Keep
  claim/process/complete/fail behavior behind `src/app/runtime/request-drain.ts`;
  startup arms it in the background, and shutdown waits for active request work
  before closing runtime resources.
- Tests at public seams should use the same narrow contracts and guards as the
  runtime. If a test needs `as any` to inspect a payload, either type the fake
  through the real interface or validate the payload with the subsystem helper
  before asserting on it.
- When a module needs a narrow slice of a store, use `Pick<DomainStore, ...>`
  locally instead of exporting a one-off duplicate interface.

## Supported Entry Points

These are the source barrels that still deserve to exist:

- `src/index.ts`
- `src/app/runtime/index.ts`
- `src/kernel/agent/index.ts`
- `src/panda/index.ts`
- `src/domain/agents/index.ts`
- `src/domain/commands/index.ts`
- `src/domain/identity/index.ts`
- `src/domain/sessions/index.ts`
- `src/domain/channels/index.ts`
- `src/domain/channels/actions/index.ts`
- `src/domain/channels/deliveries/index.ts`
- `src/domain/threads/index.ts`
- `src/domain/threads/requests/index.ts`
- `src/domain/threads/runtime/index.ts`
- `src/domain/scheduling/index.ts`
- `src/domain/scheduling/tasks/index.ts`
- `src/domain/watches/index.ts`
- `src/integrations/shell/index.ts`

`src/index.ts` is the package root.
Do not re-export domain repos, stores, channel integrations, or other internal plumbing from it unless we intentionally want that to become package API.

The supported package entrypoints are:

- `panda`
- `panda/app/runtime`
- `panda/kernel/agent`
- `panda/panda`
- `panda/domain/agents`
- `panda/domain/commands`
- `panda/domain/identity`
- `panda/domain/channels`
- `panda/domain/channels/actions`
- `panda/domain/channels/deliveries`
- `panda/domain/threads`
- `panda/domain/threads/requests`
- `panda/domain/threads/runtime`
- `panda/domain/scheduling`
- `panda/domain/scheduling/tasks`
- `panda/domain/watches`
- `panda/integrations/shell`

Use the root for the normal public API.
Use the subpath exports only when you intentionally need a secondary boundary.
Inside `src`, import concrete leaf modules when the caller already knows the
module it needs. The supported barrels are package seams, not a shortcut for
internal helper imports.

Internal stays internal.

- `src/domain/credentials` is runtime plumbing, not package API
- `src/domain/sessions/**` is internal for now; it is a real domain boundary, but not a supported package export yet
- `src/domain/sessions/conversations` and `src/domain/sessions/routes` stay behind `domain/sessions`
- `src/prompts/**` is source-of-truth for editable model text, but it is not package API
- `src/panda/tools/*.ts` leaf files are tool interfaces. Put shared adapters in
  `src/integrations/*`, pure helpers in `src/lib/*`, and Panda policy outside
  the tools folder.
- Tool-specific dependency seams belong in the tool leaf unless multiple
  modules share them. Do not add one-interface integration files just so one
  concrete adapter can `implements` them; TypeScript's structural typing already
  gives the test seam.
- Panda tool artifact media-root, agent-key, and scope-key handling is centralized
  in `src/panda/tools/artifact-paths.ts`; image, view_media, wiki, and future
  media tools should not clone filesystem path guards.
- `src/panda/subagents/service.ts` and related Panda helpers are internal, not public persona API
- shared web-fetch, web-research, and SSRF helpers live under `src/integrations/web`; Panda tool leaf files call them instead of owning them
- readable HTML cleanup/extraction lives in `src/integrations/web/html-content.ts`;
  `web-fetch.ts` owns safe HTTP fetching, DNS pinning, redirects, byte limits,
  and content-type gating, then delegates page readability there

Leaf-folder barrels are gone on purpose.
If you feel tempted to add `tools/index.ts` or `contexts/index.ts` again, don't.
The same rule applies to internal domain and integration folders that are not
listed as supported entrypoints above. Import the real module instead of
gateway, connector leases, execution environments, or browser internals.
Sibling imports follow the same rule: `../sessions/store.js` is clearer than
`../sessions/index.js` when the caller already needs the store contract.

## Postgres Rule

Panda is Postgres-first. Do not cosplay portability.

- If a repo abstraction is buying us nothing, collapse it.
- Prefer `repo.ts` over `store.ts` plus `postgres.ts` when there is only one real implementation.
- Keep concrete Postgres details out of `kernel`.

The short version:

- `store.ts` means a real contract with multiple meaningful consumers
- `repo.ts` means a concrete persistence API
- `postgres.ts` should survive only when the file is actually exposing a domain boundary that still wants that name

Pragmatism wins over purity here. The goal is less indirection, not prettier indirection.

## Smell List

Stop and rethink if you see one of these:

- `panda` growing daemon bootstrap, DB pool setup, or connector boot logic
- `kernel` importing concrete provider adapters or channel code
- `domain` importing Telegram or WhatsApp code
- giant inline prompt literals living inside runtime files
- folders named `common`, `shared`, or `utils` filling with mixed junk
- one-implementation interfaces surviving out of habit
- barrel files forcing readers to play import roulette
