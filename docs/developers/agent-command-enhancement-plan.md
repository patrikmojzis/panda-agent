# Agent Command Enhancement Plan

Last inspected: 2026-07-05.

Sources used:

- `pnpm --silent dev commands --output json`
- `src/app/cli.ts`
- `scripts/agent-command-shim/panda`
- command modules under `src/domain`, `src/integrations`, and `src/panda/commands`
- Brave Search docs for Web, News, Video, Image, Place, and LLM Context search

External references:

- Brave Web Search: https://api-dashboard.search.brave.com/documentation/services/web-search
- Brave News Search: https://api-dashboard.search.brave.com/documentation/services/news-search
- Brave Video Search: https://api-dashboard.search.brave.com/documentation/services/video-search
- Brave Image Search: https://api-dashboard.search.brave.com/documentation/services/image-search
- Brave Place Search: https://api-dashboard.search.brave.com/documentation/services/place-search
- Brave LLM Context: https://api-dashboard.search.brave.com/documentation/services/llm-context

## Position

The Panda Command seam should not become the old native tool schemas with a
`--json` hat on. The target interface is a normal agent-friendly CLI:

- scalar fields become positional arguments or flags
- long bodies come from `--stdin`, `@file`, or `--content @-`
- complex nested payloads still use `--json @-`
- every command has useful `--help` and `--help --json`
- command output has stable JSON contracts plus concise text output

Keep the deep module as the Panda Command. The host CLI and Agent Command Shim
are adapters at that seam.

## Naming Direction

Use domain names when the capability is provider-neutral. Use provider names
when the command is explicitly tied to one provider's interface.

| Current namespace | Target namespace | Reason |
| --- | --- | --- |
| `web.search` | `brave.*` | The implementation is Brave Search, and Brave has multiple useful verticals now. The old `web.search` compatibility command has been removed. |
| `web.research` | `openai.web_research` now; maybe `openai.deep_research` later | Current code uses OpenAI Responses with hosted web search and a Panda prompt. The old `web.research` compatibility command has been removed. Do not call it Deep Research unless the backend actually changes to that product/interface. |
| `agent.vent` | `vent.send` | Venting is not an agent-management command. Scope already supplies the agent/session. The old `agent.vent` compatibility command has been removed. |
| `agent.skill.*` | `skill.*` | Done as preferred `skill.list/show/load/set/patch/delete`. The old `agent.skill.*` compatibility aliases have been removed. Skills are agent-scoped by command scope, so the `agent` prefix is noise. |
| `message.agent.send` | `a2a.send` | Panda-to-Panda messaging already has an A2A concept and can grow into `a2a.inspect`, `a2a.history`, etc. |
| `outbound.send` | provider namespaces | Removed the generic JSON router. Use provider commands such as `telegram.send`, `discord.send`, and `whatsapp.send` for explicit targets. |
| `app.*` | `micro-app.*` CLI group | Match Panda terminology. The old `panda app ...` CLI alias has been removed; expose `panda micro-app ...` in the CLI. |
| `audio.transcribe` | `whisper.transcribe` | Current implementation is OpenAI `whisper-1`; `audio.transcribe` has been removed after the Whisper namespace replacement. |
| `image.generate` | keep `image.generate` | The user asks for an image, not for a model. Put `gpt-image-2` behind `--model`; do not bake a replaceable model into the command name. |

## Cross-Cutting Gaps

These pay back across almost every command.

1. Generate the Agent Command Shim from command descriptors.

   Today the shim is hand-written and mostly JSON-first. That will drift. The
   descriptor should be the source of truth for help, parser shape, examples,
   JSON help, and allowed input modes.
   Progress so far:
   - `DEFAULT_AGENT_COMMAND_MODULES` is now the default command module catalog:
     each entry carries the descriptor, generated shim route metadata, and the
     default policy capability key. Descriptor and shim route catalogs are
     compatibility projections, not separate source-of-truth lists.
   - Command leases now project allowed Panda Commands from the command module
     policy metadata instead of a second hand-maintained allowlist in runtime
     code. Identity-scoped app links, credential mutation commands, readonly
     Postgres, and agent-skill operation gates live on the module entry.
   - `RuntimeCommandLeaseService` is catalog-agnostic; runtime assembly supplies
     the selected module catalog instead of the lease module importing Panda
     defaults.
   - Low-dependency runtime command handlers now register through module
     `createCommand` factories. This covers time, vent, web/Brave, OpenAI web
     research, image generation, and Whisper without forcing store-heavy or
     daemon-only command families through the same seam prematurely.
   - Watch and schedule are now the first store-backed runtime command families
     registered through module factories. Their module deps are explicit
     domain stores/mutations, not a full runtime object.
   - Micro-app runtime commands now register through module factories too.
     Their deps are explicit app service/auth/url callbacks, so runtime
     assembly supplies capabilities without owning app command construction.
   - Store-backed agent/session/profile/env/Postgres command families now
     register through module factories with explicit store or adapter deps.
     Runtime bootstrap still owns the concrete stores, but no longer owns those
     command constructors.
   - Environment and wiki command families now follow the same module-factory
     shape. Runtime supplies lifecycle, environment store, wiki service, and
     file resolver deps; the module catalog owns handler construction.
   - Late-bound runtime command families can now instantiate selected command
     modules by name. `subagent.spawn` uses this path after the
     `SubagentSessionService` exists, instead of bypassing the module catalog.
   - Daemon-owned channel, email, and A2A command families now use selected
     module instantiation too. Runtime bootstrap explicitly excludes those
     daemon-only names; daemon bootstrap supplies connector, conversation,
     delivery, channel-action, email, and A2A deps and requires every selected
     module to materialize.
   - Subagent tool groups now keep only native/direct tool names in the domain
     group catalog. Panda Command names are contributed by command module
     `policy.toolGroups`, so future modules can join a group without editing a
     parallel command allowlist.
   - Runtime and daemon assembly now accept a preferred `commandCatalog` object,
     while still accepting raw `commandModules` for compatibility. Bootstrap,
     leases, late-bound subagent spawning, daemon channel/A2A registration, and
     subagent tool-policy expansion all use the selected catalog instead of
     reaching back to `DEFAULT_AGENT_COMMAND_MODULES`.
   - Runtime bootstrap runs raw `commandModules` through duplicate-name
     validation too, and rejects callers that pass both `commandCatalog` and
     `commandModules` so there is one catalog source of truth per runtime.
   - Command modules now own their registration phase: `runtime`,
     `runtime.subagent`, `daemon.channel`, or `daemon.a2a`. Runtime and daemon
     assembly filter by that metadata, so adding a command no longer requires a
     second static daemon-name array.
   - `buildDefaultAgentCommandModules({extraModules})` is the public Panda
     catalog composition seam. It appends extension modules to the default
     catalog and fails early on duplicate command names.
   - `createCommandCatalog` is the deeper catalog interface over command modules:
     it validates duplicate names once and exposes lookup, descriptor/route
     projection, policy group expansion, phase filtering, and command
     instantiation without callers juggling raw arrays plus helper functions.
   - `defineCommandModule` and `defineCommandCatalogModule` are the public
     constructor helpers for future extension packages. They do not load
     external code; they make the module shape explicit and type-stable while
     defaulting catalog capability keys and generated JSON routes from the
     command descriptor/route metadata.
   - Descriptor and shim-route adapters use `commandDescriptorsFromModules`
     and `commandRoutesFromModules`, so custom catalogs can project discovery
     and route metadata without cloning default-only arrays.
   - `DEFAULT_AGENT_COMMAND_DESCRIPTORS` is now the shared descriptor catalog
     for both `panda commands` and the model-facing command catalog context.
   - `DEFAULT_AGENT_COMMAND_SHIM_ROUTES` now defines the default shim route
     contract keyed by Panda Command name, and tests execute local
     `--help --json` through the shim for every route without command
     transport. This is the guardrail before full shim generation.
   - Empty compatibility descriptor/route registries have been removed. The
     default catalog is the catalog; old aliases stay deleted instead of living
     behind a second merge point.
   - `scripts/agent-command-shim/routes.generated.sh` is generated from that
     route contract and handles descriptor-backed local text `--help`,
     local JSON `--help --json`, and transport-backed `--json` dispatch in the
     Agent Command Shim before custom rich parsers run.
   - Command argument descriptors now support display value labels and boolean
     flag help, so native surfaces like `a2a.send` can advertise standard CLI
     shapes such as `--to-session <session-id>`, `--stdin`, and `--file <path>`
     from the descriptor instead of shell-only prose.
   - Command argument descriptors now support repeatable flags, conflict
     metadata, required companion flags, and default values. High-traffic
     send/policy commands such as `a2a.send`, `email.send`, provider sends,
     `subagent.spawn`, `subagent.profile.upsert`, `skill.list`, and
     `image.generate` expose that metadata in `--help --json`.
   - Body/config argument descriptors now expose `valueSources` so agents can
     tell when a field accepts literal text/JSON, `@file`, or `@-` without
     reverse-engineering `valueName` strings.
   - Command argument descriptors now support positional arguments. The first
     scalar native forms are live in the Agent Command Shim: `panda time now`,
    `panda watch disable <watch-id> [--reason <text|@file|@->]`, and
    `panda schedule cancel <task-id> [--reason <text|@file|@->]`.
   - A2A messaging has a native public form:
     `panda a2a send (--to-session <session-id>|--to-agent <agent-key>) (--text <text|@file|@->|--stdin|--file <path>)...`.
     Its `--text` field now advertises the standard `text|@file|@-` body
     contract in descriptor help.
     Attachments stay generic at the CLI boundary: images use `--file`, not a
     separate `--image` flag.
   - A2A receipt reads are native too: `panda a2a inspect <delivery-id>` checks
     one visible delivery, and `panda a2a history [--peer-session <session-id>] [--limit <n>]`
     lists recent visible deliveries for the current session.
   - The first read-only wiki native forms are live in the Agent Command Shim:
     `panda wiki read <path> [--locale <locale>]`,
     `panda wiki search <query> [--path <path>] [--locale <locale>] [--limit <n>]`, and
     `panda wiki list [path] [--limit <n>] [--include-archived]`.
   - Wiki archive review now has a native diff command:
     `panda wiki diff <left-path> <right-path> [--locale <locale>] [--context <n>]`.
   - The next small native reads/mutations are live in the Agent Command Shim:
     `panda session prompt current read <brief|memory|heartbeat>`,
     `panda skill load <skill-key>`,
     `panda skill delete <skill-key> --yes`,
     `panda env set <key> (--stdin|--from-file <path>)`,
     `panda env clear <key>`, and
    `panda telegram react <message-id> (--emoji <emoji>|--remove) --chat <id> --connector <key>`.
   - The next native body/scalar wrappers are live in the Agent Command Shim:
     `panda session prompt current set <brief|memory|heartbeat> --content <text|@file|@->`
     plus `panda environment list [--state <state>]`,
     `panda environment show <environment-id>`, and
     `panda environment stop <environment-id>`.
   - Provider-specific human-channel sends are now split for the channels with
     durable outbound adapters: `telegram.send`, `discord.send`, and
     `whatsapp.send`.
   - Telegram now has a durable history helper:
     `panda telegram history --chat <conversation-id> [--connector <key>]`
     reads current-session inbound transcript records plus outbound delivery
     receipts. It does not call Telegram for server-side history.
   - Telegram media fetch is live:
     `panda telegram media fetch <media-id> --chat <conversation-id> [--save <path>]`
     copies a session-visible stored media file into the command workspace and
     returns a `view_media` artifact for images/PDFs.
   - Discord and WhatsApp now have durable history helpers:
     `panda discord history --channel <channel-id>` and
     `panda whatsapp history --chat <jid-or-phone>` read current-session inbound
     transcript records plus outbound delivery receipts. They do not call the
     provider for server-side history.
   - Disposable environment log inspection is live:
     `panda environment logs <environment-id> [--role control|workspace|all] [--tail <n>]`
     reads tail-limited manager-backed Docker logs after session ownership
     checks.
   - The Brave vertical split is live for Web, News, Video, Image, LLM Context,
     and Place Search. The old `web.search` compatibility command has been
     removed.
   - Watch source/detector schema discovery now lives on the standard help path:
     `panda watch create --help --json` and
     `panda watch update --help --json` include the detailed schema catalog.
     The old `watch.schema` compatibility command has been removed.
   - The default model-facing command catalog removes compatibility aliases.
     Removed aliases such as `agent.vent`, `agent.skill.*`,
     `message.agent.send`, `outbound.send`, `todo.update`, `watch.schema`,
     `web.search`, `web.research`, and `audio.transcribe` are no longer
     executable through the runtime/shim.
   - Subagent profile discovery and lifecycle now use native commands:
     `panda subagent profile list [--include-disabled]`,
     `panda subagent profile show <slug> [--include-disabled]`,
     `panda subagent profile enable <slug>`, and
     `panda subagent profile disable <slug>`. The agent lane disables profiles
     instead of hard-deleting them.

2. Extend descriptors beyond one generic `json` argument.

   Default command descriptors are no longer JSON-only. The descriptor contract
   now covers positional arguments, boolean flags, enum flags, repeatable flags,
   conflict metadata, required companion flags, default values, and
   `valueSources` for body/config inputs that accept literal values, `@file`,
   or `@-`.

3. Standardize body input.

   Use this convention everywhere:

   ```bash
   --text "short body"
   --text @message.md
   --text @-
   --content @page.md
   --json @payload.json
   --json @-
   ```

4. Standardize output contracts.

   Every command should return machine JSON with `status` or `ok`, durable ids,
   and any `artifact`. Text output should be short and useful, not a JSON dump.

5. Keep namespace policy, not legacy tool policy.

   Capabilities should be `wiki.*`, `telegram.*`, `email.*`, etc. The model
   can discover exact commands at runtime, so command namespaces can be richer
   than the old always-visible tool list.

6. Add `list`, `show`, and `status` commands where the old native tool surface
   omitted them only to save prompt space.

   This applies especially to watches, schedules, execution environments,
   skills, A2A bindings, email accounts/messages, micro-apps, and channel
   conversations.

## Native Core Tools

These should stay model-visible for now.

| Tool | Decision | Enhancement |
| --- | --- | --- |
| `bash` | Keep native. It is the transport and workspace execution interface. | Keep pushing domain work into `panda ...`; make command access refresh boring and invisible. |
| `background_job_status` | Keep native. | Keep the result contract stable across bash, web research, and image jobs. |
| `background_job_wait` | Keep native. | Keep as the standard wait primitive; do not invent per-command wait loops unless the CLI flag only calls this path. |
| `background_job_cancel` | Keep native. | Keep cancellation generic and thread-scoped. |
| `view_media` | Keep native. | Treat it as the renderer for command artifacts. Later add page/range controls for PDFs if needed. |
| `thinking_set` | Keep native until there is a runtime-effects contract. | A CLI command cannot currently mutate live `RunContext` for the next model request cleanly. |
| `browser` | Keep native for now. | Move only after a `browser.action` command artifact contract exists for screenshots, PDFs, state, and previews. |

## Agent Commands

Priority:

- P0: fix CLI ergonomics for already-useful commands
- P1: add high-leverage domain capability
- P2: polish or less common expansion

### Time

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `time.now` | Native `panda time now [--timezone <iana>] [--format iso\|local\|full]`; `--json` input remains. | Done. Keeps the full timestamp contract and adds a `display` field selected by format. | P0 |

### Web, Brave, And OpenAI Research

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `web.fetch` / `web.read` | Native `panda web fetch <url> [--chunk-chars <n>] [--format markdown\|text] [--save <path>] [--include-links\|--no-links]` plus `panda web read <resource-ref> [--cursor <cursor>] [--chunk-chars <n>]`; `--json` input remains. | Done for safe public-resource classification, model-ready untrusted content, short-lived resumable reads, binary artifacts, structured failures, and bounded retries. `--chunk-chars` limits model output; `WEB_FETCH_DOWNLOAD_LIMIT_BYTES` controls the separate network bound. | P0 |
| `web.search` | Removed compatibility alias for Brave Web Search. | Done. Use `brave.web.search`. | P2 |
| `brave.web.search` | Native `panda brave web search <query> [-n\|--count <n>] [--offset <n>] [--freshness pd\|pw\|pm\|py\|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off\|moderate\|strict] [--extra-snippets] [--goggles <url-or-inline>]`; `--json` input remains. | Done for Web Search. | P0 |
| `brave.news.search` | Native `panda brave news search <query> [-n\|--count <n>] [--offset <n>] [--freshness pd\|pw\|pm\|py\|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off\|moderate\|strict] [--extra-snippets] [--goggles <url-or-inline>]`; `--json` input remains. | Done for News Search. | P0 |
| `brave.video.search` | Native `panda brave video search <query> [-n\|--count <n>] [--offset <n>] [--freshness pd\|pw\|pm\|py\|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--safe off\|moderate\|strict] [--no-spellcheck]`; `--json` input remains. | Done for Video Search, including country/lang, safe search, spellcheck disable, count, and offset. | P1 |
| `brave.image.search` | Native `panda brave image search <query> [-n\|--count <n>] [--country <code>] [--lang <code>] [--safe strict\|off] [--no-spellcheck]`; `--json` input remains. | Done for Image Search, including country/lang, spellcheck disable, result count up to 200, thumbnail/source-page/original-image fields, and strict/off safe search. | P1 |
| `brave.place.search` | Native `panda brave place search [query] [--location <location>\|--lat <number> --lon <number>] [-n\|--count <n>] [--radius <meters>] [--country <code>] [--lang <code>] [--units metric\|imperial] [--safe off\|moderate\|strict] [--no-spellcheck]`; `--json` input remains. | Done for Place Search, including location string, coordinate search, radius, country/lang, units, spellcheck disable, and compact POI normalization. | P1 |
| `brave.place.poi` / `brave.place.description` | Native `panda brave place poi <id> [id...]` and `panda brave place description <id> [id...]`; `--json` input remains. | Done for Brave detail endpoints. Place ids are ephemeral and should be used immediately, not stored. | P1 |
| `brave.llm.context` | Native `panda brave llm context <query> [-n\|--count <n>] [--max-tokens <n>] [--max-urls <n>] [--threshold strict\|balanced\|lenient\|disabled] [--local] [--freshness pd\|pw\|pm\|py\|YYYY-MM-DDtoYYYY-MM-DD] [--country <code>] [--lang <code>] [--goggles <url-or-inline>]`; `--json` input remains. | Done for LLM Context. This may become the default agent search path because Brave describes it as built for agents and RAG. | P0 |
| `openai.web_research` | Native `panda openai web-research <query\|@file\|@-> [--model <model>] [--effort low\|medium\|high]`; `--json` accepts `{query, model, effort}`. | Done as the provider-accurate hosted web-search research command. Waiting stays in the core `background_job_wait` tool. Reserve `openai.deep_research` for a real backend switch. | P1 |
| `web.research` | Removed compatibility alias for OpenAI hosted web research. | Done. Use `panda openai web-research`. | P2 |

### Watches

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `watch.schema` | Removed compatibility alias. | Standard discovery is now `panda watch create --help --json` and `panda watch update --help --json`, both carrying the detailed schema catalog. | Done |
| `watch.create` | Native shortcut: `panda watch create --title <text\|@file\|@-> --every <minutes> (--url <url> --value-path <path> --percent-change <n> [--label <text\|@file\|@->]\|--source-json <json\|@file\|@-> --detector-json <json\|@file\|@-> [--source-kind <kind>] [--detector-kind <kind>]) [--disabled]`; `--json` input remains. | Done. HTTP JSON scalar percent-change watches have native shortcut flags; nested source/detector JSON remains the advanced path for structured probes. | P0 |
| `watch.update` | Native `panda watch update <watch-id> [--title <text\|@file\|@->] [--every <minutes>] [--url <url> --value-path <path> [--label <text\|@file\|@->]] [--percent-change <n>] [--source-json <json\|@file\|@->] [--detector-json <json\|@file\|@->] [--source-kind <kind>] [--detector-kind <kind>] [--enable\|--disable]`; `--json` input remains. | Done. HTTP JSON scalar percent-change updates have native shortcut flags; nested source/detector JSON and kind assertions remain the advanced path. | P0 |
| `watch.disable` | Native `panda watch disable <watch-id> [--reason <text\|@file\|@->]`; `--json` input remains. | Done. | P0 |
| `watch.list` / `watch.show` | Native `panda watch list [--status enabled|disabled|all] [--limit <n>]` and `panda watch show <watch-id>`; `--json` input remains. | Done so agents can discover watch ids and inspect configs without prompt-bloating context. | P0 |
| `watch.runs` | Native `panda watch runs <watch-id> [--limit <n>]`; `--json` input remains. | Done. Returns compact session-scoped run status, timestamps, errors, and emitted event summaries without raw event payloads. | P1 |

### Schedules

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `schedule.create` | Native `panda schedule create <title> (--at <iso>\|--cron <expr> --timezone <tz>) --instruction <text\|@file\|@-> [--disabled]`; `--json` input remains. | Done. Supports `--disabled` because creating inactive then enabling later is a normal operator flow. | P0 |
| `schedule.update` | Native `panda schedule update <task-id> [--title <text|@file|@->] [--at <iso>|--cron <expr> --timezone <tz>] [--instruction <text|@file|@->] [--enable|--disable]`; `--json` input remains. | Done. Native flags cover the common edit loop without hand-written nested JSON. | P0 |
| `schedule.cancel` | Native `panda schedule cancel <task-id> [--reason <text\|@file\|@->]`; `--json` input remains. | Done. | P0 |
| `schedule.list` / `schedule.show` | Native `panda schedule list [--status active|disabled|completed|cancelled|all] [--limit <n>]` and `panda schedule show <task-id>`; `--json` input remains. | Done so agents can discover task ids and inspect instructions without prompt-bloating context. | P0 |
| `schedule.runs` | Native `panda schedule runs <task-id> [--limit <n>]`; `--json` input remains. | Done. Returns compact session-scoped run status, timestamps, thread linkage, and errors without expanding transcripts. | P1 |

### Micro-Apps

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `micro-app.check` | Native `panda micro-app check [app-slug]`; `--json` input remains. The old `panda app ...` alias has been removed. | Done. | P0 |
| `micro-app.create` | Native `panda micro-app create <slug> --name <text|@file|@-> [--description <text|@file|@->] [--identity-scoped] [--schema <sql|@file|@->]`; `--json` input remains. The old `panda app ...` alias has been removed. | Done. | P0 |
| `micro-app.link.create` | Native `panda micro-app link create <app-slug> [--expires <minutes|Nm|Nh>]`; `--json` input remains. The old `panda app ...` alias has been removed. | Done. Keeps identity requirement from scope. | P0 |
| `micro-app.list` | Native `panda micro-app list [app-slug] [--full]`; `--json` input remains. The old `panda app ...` alias has been removed. | Done. Full detail stays scoped to one app. | P0 |
| `micro-app.view` | Native `panda micro-app view <app-slug> <view-name> [--param key=value] [--params <json|@file|@->] [--page-size <n>] [--offset <n>]`; `--json` input remains. The old `panda app ...` alias has been removed. | Done. | P1 |
| `micro-app.action` | Native `panda micro-app action <app-slug> <action-name> [--input <json|@file|@->]`; `--json` input remains. The old `panda app ...` alias has been removed. | Native form done. Add dry-run/preflight later if action manifests expose enough schema. | P1 |

### Execution Environments

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `environment.create` | Native `panda environment create [--label <text\|@file\|@->] [--ttl <hours\|Nh>] [--setup-script <path>]`; `--json` input remains. | Done for label, TTL, and setup script. No `--wait` flag until create returns a real waitable operation instead of fake polling. Status output already includes workspace/inbox/artifact paths when available. | P0 |
| `environment.list` | Native `panda environment list [--state <state>]`; `--json` accepts `{state}`. | Done. Lists disposable environments owned by the current session. | P0 |
| `environment.show` | Native `panda environment show <environment-id>`; `--json` accepts `{environmentId}`. | Done. Shows state, paths, expiry, and setup metadata for a session-owned environment. | P0 |
| `environment.stop` | Native `panda environment stop <environment-id>`; `--json` input remains. | Done for the native wrapper. | P0 |
| `environment.logs` | Native `panda environment logs <environment-id> [--role control\|workspace\|all] [--tail <n>]`; `--json` input remains. | Done for manager-backed, tail-limited Docker logs from the session-owned disposable control/workspace containers. | P1 |

### Skills

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `skill.list` | Native `panda skill list [--tag <tag>...] [--output keys|json|table]`; `--json` accepts `{tag}` or `{tags}` as structured input only. | Done. Defaults to one key per line; JSON and table output are explicit. | P0 |
| `skill.show` | Native `panda skill show <skill-key>`; `--json` accepts `{skillKey}`. | Done. Reads the full body without incrementing `loadCount`; `skill.load` remains the active context-load command. | P0 |
| `skill.load` | Native `panda skill load <skill-key>`; `--json` accepts `{skillKey}`. | Done as preferred command id. Later add `--content-only` only if callers need to avoid metadata. | P0 |
| `skill.set` | Native `panda skill set <skill-key> --description <text|@file|@-> --content <text|@file|@-> [--tag <tag>...]`; `--json` accepts `{skillKey, description, content, tags}`. | Done for current store capabilities. Later add `--tag-clear`/tag patching only if the store supports it. | P0 |
| `skill.patch` | Native `panda skill patch <skill-key> --description <text|@file|@->`; `--json` accepts `{skillKey, description}`. | Done for current store capabilities. Later allow tag patching if the store supports it. | P1 |
| `skill.delete` | Native `panda skill delete <skill-key> --yes`; `--json` accepts `{skillKey}`. | Done as preferred command id and native wrapper. Use `--yes`, not `--force`, because deletion confirmation is the concern. | P0 |
| `agent.skill.*` | Removed compatibility aliases for load/set/patch/delete. | Use `panda skill list/show/load/set/patch/delete`. Scope already supplies the agent key. | Done |

### Readonly Postgres

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `postgres.readonly.query` | Native `panda postgres readonly query (--sql <text\|@file\|@-> [--max-rows <n>]\|--schema-help)`; `--json` input remains. | Done for SQL input ergonomics, bounded row caps, and static scoped-view schema guidance. Table text output is still intentionally skipped; JSON is the agent-friendly contract. | P0 |

### Wiki

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `wiki.read` | Native `panda wiki read <path> [--locale <locale>] [--format json\|markdown]`; `--json` input remains. | Done. `json` keeps the full page object; `markdown` returns a compact content envelope for agent reading. | P0 |
| `wiki.search` | Native `panda wiki search <query> [--path <prefix>] [--locale <locale>] [--limit <n>]`; `--json` input remains. | Done for scoped result limiting plus count/truncated metadata. | P0 |
| `wiki.list` | Native `panda wiki list [path] [--limit N] [--include-archived] [--locale <locale>]`; `--json` input remains. | Done for the first read-only wrapper. | P0 |
| `wiki.diff` | Native `panda wiki diff <left-path> <right-path> [--locale <locale>] [--context <n>]`; `--json` input remains. | Done for compact namespace-scoped content diffs, especially archived-vs-live review before restore/overwrite. | P1 |
| `wiki.write` | Native `panda wiki write page <path> --content <text\|@file\|@-> [--title <text\|@file\|@->] [--description <text\|@file\|@->] [--tag <tag>...] [--published\|--draft] [--private\|--public] [--create\|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]`; `--json` input remains. | Done for the page wrapper, including title, description, tags, published/private/create toggles, locale, and base update checks. | P0 |
| `wiki.write.section` | Native `panda wiki write section <path> <section> --content <text\|@file\|@-> [--title <text\|@file\|@->] [--create\|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]`; `--json` input remains. | Done for the section wrapper, including title, create toggles, locale, and base update checks. | P0 |
| `wiki.move` | Native `panda wiki move <path> <destination-path> [--rewrite-links] [--locale <locale>] [--base-updated-at <timestamp>]`; `--json` input remains. | Done for move ergonomics, including locale and optimistic base update checks. Add link-rewrite reporting polish later only if the result shape gets too noisy. | P0 |
| `wiki.archive` | Native `panda wiki archive <path> [--locale <locale>] [--base-updated-at <timestamp>]`; `--json` input remains. | Done for archive ergonomics, including locale and optimistic base update checks. | P0 |
| `wiki.restore` | Native `panda wiki restore <archived-path> <destination-path> [--locale <locale>] [--base-updated-at <timestamp>]`; `--json` input remains. | Done for restoring archived pages to explicit live destinations, including locale and optimistic base update checks. The destination is required so Panda does not guess a lost original path from an archive filename. | P1 |
| `wiki.attach.image` | Native `panda wiki attach image <path> <section> --slot <slot> --source <image-path> --alt <text\|@file\|@-> [--caption <text\|@file\|@->] [--title <text\|@file\|@->] [--create\|--no-create] [--locale <locale>] [--base-updated-at <timestamp>]`; `--json` input remains. | Done for source path, alt/caption/title text, locale, create toggle, and base update checks. | P1 |
| `wiki.fetch.asset` | Native `panda wiki fetch asset <asset-path>`; `--json` input remains. | Done for fetch ergonomics. The output artifact stays viewable through `view_media`. | P0 |
| `wiki.delete.asset` | Native `panda wiki delete asset <asset-path> --yes`; `--json` input remains. | Done for explicit namespace-scoped asset deletion. It does not rewrite pages that reference the asset; use page reads/searches first when unsure. | P1 |

High-value future wiki commands: `wiki.history` and `wiki.search --semantic` if
there is an embedding seam.

### Session Prompts

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `session.prompt.read` | Native `panda session prompt current read <brief|memory|heartbeat>`; `--json` input remains. | Done. | P0 |
| `session.prompt.set` | Native `panda session prompt current set <brief|memory|heartbeat> --content <text|@file|@->`; `--json` input remains. | Done for the native wrapper. | P0 |
| `session.prompt.transform` | Native `panda session prompt current transform <brief\|memory\|heartbeat> (--append <text\|@file\|@->\|--prepend <text\|@file\|@->\|--replace <pattern> --with <text\|@file\|@->\|--expression <expr\|@file\|@->)`; `--json` input remains. | Done for safe shorthands while keeping the validated expression mode. | P1 |

### Todo

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `todo.update` | Removed compatibility alias for replacing the whole list from JSON. | Use `panda todo add`, `panda todo done`, `panda todo block`, and `panda todo clear`. The native item commands are safer than full-list replacement. | Done |
| `todo.add` / `todo.done` / `todo.block` | Native `panda todo add <text|@file|@-> [--status pending|in_progress|blocked]`, `panda todo done <index>`, and `panda todo block <index>`; `--json` input remains. | Done. Indexes are 1-based to keep mutation deterministic without fuzzy text matching or hidden ids. | P0 |
| `todo.clear` | Native `panda todo clear`; `--json` accepts `{}`. | Done as a tiny explicit command instead of forcing `todo.update {"items":[]}`. | P0 |

### Subagents

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `subagent.profile.list` / `subagent.profile.show` | Native `panda subagent profile list [--include-disabled]` and `panda subagent profile show <slug> [--include-disabled]`; `--json` input remains. | Done. List omits prompts; show includes the full profile prompt on demand. | P1 |
| `subagent.profile.upsert` | Native `panda subagent profile upsert <slug> --description <text\|@file\|@-> --prompt <text\|@file\|@-> --tool-group <group>... [--model <model>] [--thinking low\|medium\|high\|xhigh] [--enabled\|--disabled]`; `--json` input remains. | Done for description, prompt, repeatable tool groups, model, thinking, and enabled/disabled state. | P1 |
| `subagent.profile.enable` / `subagent.profile.disable` | Native `panda subagent profile enable <slug>` and `panda subagent profile disable <slug>`; `--json` input remains. | Done. Disabling is the agent-safe lifecycle operation; hard delete belongs in operator/admin tooling if needed. | P1 |
| `subagent.spawn` | Native `panda subagent spawn (<task\|@file\|@->\|--prompt <text\|@file\|@->) [--profile <slug>\|--tool-group <group>...] [--context <text\|@file\|@->] [(--environment <environment-id> [--isolated]\|--agent-workspace)] [--credential <env-key>...]`; `--json` input remains. | Done for positional or flag prompt input, profile, context, isolated environment, ad-hoc tool groups, and credential allowlists. Keep A2A completion semantics. | P0 |

### A2A Message

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `message.agent.send` | Removed compatibility alias. | Use `a2a.send`: `panda a2a send (--to-session <session-id>\|--to-agent <agent-key>) (--text <text\|@file\|@->\|--stdin\|--file <path>)...`. Images use `--file` because A2A transports attachments generically. | Done |
| `a2a.inspect` / `a2a.history` | Native `panda a2a inspect <delivery-id>` and `panda a2a history [--peer-session <session-id>] [--direction inbound\|outbound\|all] [--limit <n>]`. | Done. Reads are scoped to deliveries where the current session is sender or receiver. | P1 |

### Human Channels

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `outbound.send` | Removed compatibility command. | Use provider commands for explicit targets. Do not keep a generic hidden router; it competes with the richer channel-native CLIs. | Done |
| `telegram.send` | Native `panda telegram send --chat <conversation-id> --connector <key> (--text <text\|@file\|@->\|--stdin\|--image <path>\|--file <path>)... [--reply-to-message-id <message-id>]`; `--json` input remains. | Done for explicit chat sends with repeatable text, image, and file items, plus `--reply-to-message-id`. | P0 |
| `discord.channel.list` | Native `panda discord channel list [--connector <key>]`; `--json` input remains. | Done for current-session Discord channel discovery across enabled connectors, returning connector keys and channel ids without exposing bot config or credentials. | P1 |
| `discord.history` | Native `panda discord history --channel <channel-id> [--connector <key>] [--direction inbound\|outbound\|all] [--limit <n>]`; `--json` input remains. | Done for durable Panda records: inbound thread messages and outbound delivery receipts scoped to the current session. This is not a Discord server-side history API. | P1 |
| `discord.send` | Native `panda discord send --channel <channel-id> --connector <key> [--thread <thread-id>] [--guild <guild-id>] (--text <text\|@file\|@->\|--stdin\|--image <path>\|--file <path>)... [--reply-to-message-id <message-id>]`; `--json` input remains. | Done for explicit channel/thread sends with repeatable text, image, and file items, plus `--reply-to-message-id`. | P0 |
| `whatsapp.chat.list` | Native `panda whatsapp chat list [--connector <key>]`; `--json` input remains. | Done for current-session WhatsApp chat discovery from durable bindings, defaulting to the configured connector key and returning chat JIDs without socket/login state. | P1 |
| `whatsapp.history` | Native `panda whatsapp history --chat <jid-or-phone> [--connector <key>] [--direction inbound\|outbound\|all] [--limit <n>]`; `--json` input remains. | Done for durable Panda records: inbound thread messages and outbound delivery receipts scoped to the current session. This is not a WhatsApp server-side history API. | P1 |
| `whatsapp.send` | Native `panda whatsapp send --chat <jid-or-phone> --connector <key> (--text <text\|@file\|@->\|--stdin\|--image <path>\|--file <path>)...`; `--json` input remains. | Done for explicit chat sends with repeatable text, image, and file items. Phone numbers normalize to WhatsApp JIDs. | P0 |
| new | No TUI provider send command yet. | Add only after there is a real TUI delivery contract; do not fake a local UI send through generic outbound. | P1 |

Provider-specific work belongs in `telegram`, `discord`, `whatsapp`, and `tui`
namespaces. `outbound` was useful when the schema was always in model context;
it becomes a leaky abstraction once commands are discovered on demand.

### Email

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `email.account.list` | Native `panda email account list [--sendable-only]`; `--json` input remains. | Done for current-agent enabled account discovery without exposing IMAP/SMTP hosts or credential keys, including current-session sendability. | P1 |
| `email.list` | Native `panda email list [--account <key>] [--mailbox <name>] [--direction inbound\|outbound] [--limit <n>]`; `--json` input remains. | Done for session-visible recent mail, with capped results and compact summaries. | P0 |
| `email.search` | Native `panda email search <query> [--account <key>] [--mailbox <name>] [--direction inbound\|outbound] [--limit <n>]`; `--json` input remains. | Done for subject, sender, excerpt, and body search over session-visible mail. | P0 |
| `email.read` | Native `panda email read <email-id>`; `--json` input remains. | Done for full body, recipients, auth fields, and attachment metadata on session-visible messages. | P0 |
| `email.attachments.fetch` | Native `panda email attachments fetch <attachment-id> [--save <path>] [--overwrite]`; `--json` input remains. | Done for copying a session-visible stored attachment into the current workspace and returning a viewable artifact for images/PDFs. | P0 |
| `email.send` | Native `panda email send --account <key> (--to <address>... --subject <text\|@file\|@->\|--reply-to-email-id <email-id> [--reply-mode sender\|all]) --text <text\|@file\|@-> [--html <text\|@file\|@->] [--cc <address>...] [--file <path>...]`; `--json` input remains. | Done for fresh sends, replies through `--reply-to-email-id`, repeatable `--to`/`--cc`, repeatable `--file`, text/html bodies, and `--reply-mode sender\|all`. Keep richer attachment metadata in JSON until a clean flag shape is worth it. | P0 |

High-value future email commands: `email.draft` and mail action commands such
as archive, label, and mark-read when the storage contract is ready.

### Telegram

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `telegram.chat.list` | Native `panda telegram chat list [--connector <key>]`; `--json` input remains. | Done for current-session Telegram chat discovery across enabled connectors, returning connector keys and conversation ids without exposing bot config or credentials. | P1 |
| `telegram.chat.info` | Native `panda telegram chat info <conversation-id> [--connector <key>]`; `--json` input remains. | Done for current-session Telegram binding inspection from durable route metadata. It is not a live Telegram network lookup. | P1 |
| `telegram.react` | Native `panda telegram react <message-id> (--emoji <emoji>\|--remove) --chat <conversation-id> --connector <key>`; `--json` input remains. | Done for the native wrapper. | P0 |
| `telegram.edit` | Native `panda telegram edit <message-id> (--text <text\|@file\|@->\|--stdin) --chat <conversation-id> --connector <key>`; `--json` input remains. | Done for durable text edits through the Telegram action worker. | P1 |
| `telegram.delete` | Native `panda telegram delete <message-id> --chat <conversation-id> --connector <key>`; `--json` input remains. | Done for durable message deletes through the Telegram action worker. | P1 |
| `telegram.pin` | Native `panda telegram pin <message-id> --chat <conversation-id> --connector <key> [--silent]`; `--json` input remains. | Done for durable message pins through the Telegram action worker. | P1 |
| `telegram.unpin` | Native `panda telegram unpin <message-id> --chat <conversation-id> --connector <key>`; `--json` input remains. | Done for durable message unpins through the Telegram action worker. | P1 |
| `telegram.sticker.send` | Native `panda telegram sticker send --chat <conversation-id> --connector <key> (--file <path>\|--file-id <id>)`; `--json` input remains. | Done for durable sticker sends through the Telegram action worker. | P1 |
| `telegram.history` | Native `panda telegram history --chat <conversation-id> [--connector <key>] [--direction inbound\|outbound\|all] [--limit <n>]`; `--json` input remains. | Done for durable Panda records: inbound thread messages and outbound delivery receipts scoped to the current session. This is not a Telegram server-side history API. | P1 |
| `telegram.media.fetch` | Native `panda telegram media fetch <media-id> --chat <conversation-id> [--connector <key>] [--save <path>] [--overwrite]`; `--json` input remains. | Done for copying current-session stored Telegram media into the command workspace and returning `view_media` artifacts for images/PDFs. | P1 |

### Env Secrets

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `env.list` | Native `panda env list [--prefix <prefix>]`; `--json` input remains. | Done. Shows keys and metadata only; no values, previews, ciphertext, or storage paths. | P1 |
| `env.set` | Native `panda env set <key> (--stdin\|--from-file <path>)`; `--json` input remains. | Done for the native wrapper. Keep values out of stdout and logs. | P1 |
| `env.clear` | Native `panda env clear <key>`; `--json` input remains. | Good enough. | P1 |

### Agent Vent

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `vent.send` | Native `panda vent (--message <text\|@file\|@->\|--stdin)`; `--json` accepts `{message}`. | Done as the preferred surface. Add optional `--category` only if Panda Trace consumes it. | P2 |
| `agent.vent` | Removed compatibility alias for `vent.send`. | Done. Use `panda vent (--message <text\|@file\|@->\|--stdin)`. | P2 |

### Image

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `image.generate` | Native `panda image generate --prompt <text\|@file\|@-> [--image <path>...] [--model <model>] [--size <size>] [--quality low\|medium\|high\|auto] [--format png\|jpeg\|webp] [--compression <0-100>] [--background transparent\|opaque\|auto] [--moderation low\|auto] [--count <n>]`; `--json` input remains. | Done for prompt, reference images, model, size, quality, format, compression, background, moderation, and count. Waiting stays in the core `background_job_wait` tool. | P0 |

High-value future image commands: `image.edit`, `image.variation`,
`image.describe`, and `image.resize` if providers/artifact storage support them.

### Audio

| Command | Current shape | Enhancement | Priority |
| --- | --- | --- | --- |
| `whisper.transcribe` | Native `panda whisper transcribe <path> [--language <code>] [--prompt <text|@file|@->]`; `--json` input remains. | Done as the preferred Whisper-specific namespace for the current OpenAI `whisper-1` backend. Removed the old `audio.transcribe` compatibility command. | P0 |
| `whisper.translate` | Native `panda whisper translate <path> [--prompt <text|@file|@->]`; `--json` input remains. | Done for translating local audio files to English through the OpenAI Whisper translations endpoint. No `audio.translate` alias; the canonical namespace is Whisper. | P1 |

Future audio polish under `whisper`: segment output if the provider response
includes timestamps. If Panda later supports multiple speech providers,
introduce a provider-neutral `audio.*` namespace then.

## Order Of Attack

1. Descriptor and shim generation.
2. Rename the obvious namespaces, then hard-cut the old aliases:
   `brave.*`, `skill.*`, `vent.send`, `a2a.*`, `micro-app.*`, and
   `whisper.transcribe`. `micro-app.*` is now canonical, the old
   `panda app ...` CLI alias has been removed, and there is no compatibility
   descriptor/route registry left to merge hidden aliases back in.
3. P0 native-arg wrappers for scalar/read-only commands landed:
   `time.now`, `schedule.cancel`, `watch.disable`, and
   `wiki.read/search/list`, `wiki.write page/section`, `session.prompt.read`, and
   `skill.load/delete`, `env.list/set/clear`, `telegram.react`, `telegram.send`,
   `session.prompt.set`, `environment.stop`, `postgres.readonly.query`, and
   `whisper.transcribe`, `whisper.translate`, `image.generate`,
   `email.list/read/search/attachments.fetch/send`, and `web.fetch`.
4. P0 body/file commands landed for `telegram.send`, `discord.send`,
   `whatsapp.send`, `email.send`, `a2a.send`, wiki writes, and image/Whisper
   body inputs. Additional channel-specific send surfaces should wait for real
   channel contracts.
5. Brave vertical expansion: Web, News, Video, Image, LLM Context, and Place
   Search landed.
6. Rich domain additions: wiki diff/restore, A2A inspect/history,
   `telegram.history`, `telegram.media.fetch`, `discord.history`,
   `whatsapp.history`, `environment.logs`, and provider-specific media helpers.
   Wiki history should wait for a real Wiki.js version-history seam.

This keeps the command interface deep: one command seam, multiple adapters, and
domain capability that can grow without expanding the always-visible model tool
surface.
