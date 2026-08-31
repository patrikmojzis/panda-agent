# Per-Agent Live Voice Configuration and Global Voice Migration

**Date:** 31 August 2026

**Status:** Implemented

**Owner:** Panda Agent

**Decision state:** Implemented

**Citation style:** Harvard author-date

## Abstract

Panda currently selects one GPT-Live voice for every agent through the
Discord-worker environment variable `PANDA_DISCORD_VOICE_VOICE`. This is the
wrong ownership boundary: voice is an agent preference, while Discord is only
one transport for a channel-neutral live call. This plan replaces the global
environment setting with a validated, durable per-agent `liveVoice` setting,
exposes it through Control and the operator CLI, and snapshots it when a call
starts. The old variable is removed without a compatibility reader or
backfill. Existing agents migrate explicitly to `cove`, the current default for
Panda's Codex AVAS protocol path.

The provider catalogue remains a checked-in OpenAI Live adapter contract. It
does not depend on `codex app-server` or confuse the public Realtime V2 voice
catalogue with the private V1/V3 catalogue used by Panda. The implementation
also replaces the Discord-named experimental flag with a channel-neutral
operator kill switch and renames two provider-specific environment settings.

## 1. Context and problem statement

The current Discord worker reads `PANDA_DISCORD_VOICE_VOICE` while constructing
the OpenAI Live provider. Every agent therefore inherits one deployment-wide
voice, even though the durable persona belongs to the agent and the live-call
orchestration is already channel-neutral (Panda Agent, 2026b; Panda Agent,
2026e).

This causes four concrete problems:

1. multiple agents and users cannot choose distinct voices;
2. a future Telegram, WhatsApp or custom call transport would either inherit a
   Discord-named setting or duplicate configuration;
3. invalid voice values reach provider startup through an overloaded failure
   path; and
4. Control, CLI and the standalone voice lab have no common catalogue or
   effective-value contract.

The setting should be called the **live voice** in product surfaces and
`liveVoice` in TypeScript. ‘Voice’, ‘voice sound’ and ‘voice colour’ are useful
conversation terms, but the stored value specifically selects the provider's
synthesised voice or timbre.

## 2. Evidence and protocol boundary

Codex defines two built-in voice catalogues. Its AVAS WebRTC and existing-call
paths default to Realtime V1, reject V2 for AVAS existing calls, and validate
V1 and V3 against the same nine-voice catalogue (OpenAI Codex, 2026a; OpenAI
Codex, 2026b). Panda uses the private Codex AVAS call route and sends a
Quicksilver feature header; that header does not make the conversation a
Realtime V2 session (Panda Agent, 2026c).

The provider catalogue for Panda's current path is therefore:

| Voice | Wire value | Default |
| --- | --- | --- |
| Juniper | `juniper` | No |
| Maple | `maple` | No |
| Spruce | `spruce` | No |
| Ember | `ember` | No |
| Vale | `vale` | No |
| Breeze | `breeze` | No |
| Arbor | `arbor` | No |
| Sol | `sol` | No |
| Cove | `cove` | Yes |

Codex currently returns this checked-in catalogue from app-server rather than
discovering it from the provider at runtime. Panda should use the same source
semantics without introducing an app-server dependency. The OpenAI Live
adapter will own a versioned local catalogue and tests will expose drift when
the Codex snapshot is refreshed.

The public Realtime API currently documents a different ten-voice catalogue,
custom voice identifiers and a rule that a voice cannot change after audio has
been produced (OpenAI, 2026). Those public V2 values are not accepted as the
catalogue for Panda's private AVAS path. The immutability rule nevertheless
supports Panda's call-start snapshot policy.

## 3. Decision

Panda will store one validated live voice on each agent and snapshot it into
each newly created live-call session.

The following decisions are normative:

- the default and migration value is `cove`;
- a live call keeps the selected voice for its entire lifetime, including
  provider recovery or replacement;
- changing an agent's setting affects the next join, not an active call;
- Control and CLI consume one backend catalogue rather than duplicating voice
  arrays;
- `PANDA_DISCORD_VOICE_VOICE` is deleted with no alias, fallback, warning
  reader or migration from its value;
- `PANDA_DISCORD_VOICE_EXPERIMENTAL` becomes
  `PANDA_LIVE_VOICE_ENABLED`, still disabled by default;
- provider-specific experimental settings are renamed away from Discord; and
- neither runtime startup nor Control depends on `codex app-server`.

## 4. Ownership model

The implementation must preserve Panda's existing architecture:

```text
runtime.agents.live_voice
        |
        | read at join time
        v
LiveVoiceSessionInput.voice
        |
        | immutable call snapshot
        v
LiveVoiceProviderDefinition.createSession({ voice })
        |
        v
OpenAI Live adapter catalogue and wire validation
```

The agent owns the preference. The generic live-call session owns the effective
snapshot. The OpenAI adapter owns provider values and validation. Discord owns
only guild/channel lifecycle and media transport. Control and CLI are operator
adapters over the agent setting (Panda Agent, 2026a; Panda Agent, 2026b).

## 5. Provider catalogue

### 5.1 Single source of truth

Add `src/integrations/providers/openai-live/voices.ts` with:

- `OPENAI_LIVE_VOICES`, a readonly ordered catalogue;
- `DEFAULT_OPENAI_LIVE_VOICE`, equal to `cove`;
- `OpenAILiveVoice`, derived from the catalogue rather than repeated; and
- a strict parser/assertion that returns a bounded `unsupported_voice` error
  containing the allowed values.

Replace the private `VOICES` set and string defaults in the OpenAI wire and
provider modules. Export only the catalogue contract through the supported
`panda/integrations/openai-live` package entrypoint. Provider wire classes stay
private (Panda Agent, 2026c; Panda Agent, 2026d).

### 5.2 Catalogue maintenance

The file should identify the Codex source snapshot and protocol version in a
short source comment. Tests must assert the exact values and default. Updating
the catalogue is a deliberate provider-adapter change reviewed against a fresh
Codex checkout; it is not a runtime network operation.

The database must not use a PostgreSQL enum or a check constraint listing the
catalogue. Provider catalogues change. Persistence should enforce a bounded,
non-blank string, while application mutation and provider construction enforce
membership.

## 6. Persistence and migration

Use the next available forward-only migration number at implementation time.
Do not reserve a number in this plan because another in-flight change may claim
it first (Panda Agent, 2026f).

### 6.1 Agent preference

Add to `runtime.agents`:

```sql
live_voice TEXT NOT NULL DEFAULT 'cove'
```

Add a bounded non-blank check consistent with other agent string settings. The
migration backfills every existing agent to `cove`; it must not inspect process
environment or preserve the previous deployment-wide value.

Extend the agent domain and store with:

- `AgentRecord.liveVoice`;
- optional `liveVoice` on create/ensure input, defaulting to `cove`; and
- `setLiveVoice(agentKey, voice)` as the narrow mutation.

The store accepts an already validated provider value. Operator service and
provider construction remain defence-in-depth validation points.

### 6.2 Effective session snapshot

Add nullable `voice TEXT` to `runtime.live_voice_sessions`. Historical rows stay
`NULL` because their effective voice cannot be proven. New application writes
must supply the voice, and live-session status returns it. Null means
‘historical or unknown’, not `cove`.

Add `voice` to `LiveVoiceSessionInput`, `LiveVoiceSessionRecord`, repository row
mapping and active-session status. No transport-specific table or column is
introduced (Panda Agent, 2026g).

## 7. Call-start resolution

The Discord worker will receive a narrow read seam for the agent store. At the
last responsible moment in `join`, after the control record is authorised and
before provider startup:

1. load `control.agentKey`;
2. reject a missing or inactive agent;
3. validate `agent.liveVoice` through the injected OpenAI Live provider
   definition;
4. persist the value on the connecting live session;
5. construct the provider session with that exact value; and
6. include `voice` in join and status results.

Rejoining an already active channel is idempotent and returns the existing
snapshot. Moving channels within the same call ownership creates a new live
session and therefore reads the current agent setting again.

Provider sideband reconnection and whole-provider replacement must retain the
session snapshot; neither may reread the agent row. This prevents a settings
edit from changing voice during a call and respects provider session
immutability (OpenAI, 2026).

An unsupported stored value fails locally with `unsupported_voice` before SDP
or OAuth work. The operator receives the rejected value and current allowed
choices without secrets or raw provider errors.

## 8. Control API and UI

### 8.1 HTTP contracts

Add an authenticated catalogue endpoint:

```http
GET /live-voice/voices
```

Response:

```json
{
  "provider": "openai-live",
  "model": "gpt-live-1-codex",
  "defaultVoice": "cove",
  "voices": ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]
}
```

Expose `liveVoice` on agent detail and add:

```http
PATCH /agents/:agentKey/live-voice
Content-Type: application/json

{"voice":"juniper"}
```

The mutation must enforce agent visibility, content type, CSRF, body limits and
catalogue membership, then emit `agent_live_voice_updated` with the agent key,
old value and new value. Do not put provider secrets or raw request bodies in
audit metadata.

App/runtime assembly injects a serialisable catalogue into the Control domain.
The Control domain must not import the concrete OpenAI adapter, preserving the
import law (Panda Agent, 2026a).

### 8.2 User interface

Add a **Live voice** setting to the agent settings surface:

- select control populated only from `GET /live-voice/voices`;
- current value selected from agent detail;
- humanised labels derived from wire values;
- explicit note: ‘Applies the next time this agent joins a live call’; and
- success/error feedback using the existing mutation pattern.

Do not accept free text. Do not invent gender, accent or personality
descriptions, because Codex currently supplies identifiers rather than
authoritative metadata. Voice previews are a later product feature.

## 9. Operator CLI

Add operator commands under the existing agent module:

```text
panda agent voice list
panda agent voice get <agent-key>
panda agent voice set <agent-key> <voice>
```

All three commands support `--json`. `list` returns provider, model, default
and choices; `get` returns configured and default values; `set` validates
before writing and returns the saved agent/value. Add `--voice <voice>` to
agent create and ensure so declarative bootstrap can set a non-default value.

These are host-operator commands, not agent-facing capabilities. They must not
enter the model command catalogue, tool groups or Agent Command Shim.

## 10. Voice lab alignment

Update the adjacent `panda-voice-lab` to consume the exported
`panda/integrations/openai-live` catalogue through its development package
condition (Panda Voice Lab, 2026).

Required changes:

- default synthesis and replay to `cove` from the shared export;
- reject arbitrary `--voice` values locally;
- add `pnpm lab voices` for discoverability; and
- record the effective voice and catalogue/source version in every run
  manifest.

The lab remains independent of Panda's database and agent settings. Its CLI
selects a test voice explicitly; it does not simulate Control persistence.

## 11. Environment hard cut

Delete these variables from code, examples, Compose and documentation:

```text
PANDA_DISCORD_VOICE_VOICE
PANDA_DISCORD_VOICE_EXPERIMENTAL
PANDA_DISCORD_VOICE_DELEGATION_ACK_FILLER
PANDA_DISCORD_VOICE_SIDEBAND_PING_MS
```

Introduce:

```text
PANDA_LIVE_VOICE_ENABLED=false
PANDA_OPENAI_LIVE_DELEGATION_ACK_FILLER=
PANDA_OPENAI_LIVE_SIDEBAND_PING_MS=0
```

`PANDA_LIVE_VOICE_ENABLED` is a deployment-wide operator kill switch, not an
agent preference. Keep it disabled by default while Panda relies on a private
Codex OAuth/provider path. Parse it once in channel-neutral live-voice process
configuration and inject the result into transports. A future transport must
not add its own experimental flag for the same provider feature.

The two OpenAI settings describe provider behaviour and therefore belong to
the OpenAI Live adapter. `PANDA_DISCORD_DB_POOL_MAX` remains Discord-specific
and `CODEX_HOME` remains the OAuth source. None of the removed names receive a
compatibility alias.

## 12. Delivery sequence

Implement in the following order so each seam is testable:

1. add the provider catalogue, parser and exact contract tests;
2. add the schema migration and agent/live-session mappings;
3. add agent store and operator service mutations;
4. snapshot the voice during join and expose it through status;
5. add Control catalogue, mutation and UI;
6. add operator CLI commands and create/ensure option;
7. update the voice lab;
8. hard-cut environment names and documentation; and
9. run the full verification matrix before committing.

The schema and application changes ship together. Deployment must explicitly
set `PANDA_LIVE_VOICE_ENABLED=true`; all existing agents initially use `cove`.
Operators then customise agents through CLI or Control and remove the deleted
environment keys from the deployment.

Active calls are transient and end during worker deployment. After restart,
verify two differently configured agents by join/status and confirm each
reported snapshot. An additive schema permits a code rollback mechanically,
but this hard cut does not promise old/new environment compatibility. Prefer a
forward fix over reintroducing the removed variables.

## 13. Test and verification plan

### 13.1 Behavioural tests

Cover at minimum:

- exact V1/V3 catalogue order and `cove` default;
- unsupported value rejection before network or OAuth work;
- fresh database and upgrade backfill to `cove`;
- historical live sessions remaining `NULL` and new sessions recording voice;
- agent create, ensure, get and set behaviour;
- two agents selecting different voices in concurrent calls;
- an active call retaining its voice after an agent setting changes;
- provider sideband recovery and replacement retaining the snapshot;
- join/status returning effective voice;
- Control authentication, CSRF, visibility, validation and audit;
- Control dropdown values coming from the backend catalogue;
- CLI human and JSON output, including invalid input;
- voice-lab default, validation, discovery and run manifest; and
- source and documentation containing none of the removed environment names.

### 13.2 Repository gates

Run focused Vitest suites for provider, agent Postgres, live-voice Postgres,
Discord join/status, Control HTTP and CLI behaviour, followed by:

```bash
pnpm typecheck
pnpm architecture:import-law:ratchet
pnpm control:typecheck
pnpm control:build
pnpm ci:postgres-schema-manifest:update
pnpm ci:postgres-startup
git diff --check
```

Review the generated schema-manifest diff. Run `pnpm smoke` against a disposable
`TEST_DATABASE_URL` because the change crosses persistence, worker and provider
startup boundaries. `pnpm agent-command-shim:check` is not required unless the
implementation unexpectedly changes the agent-facing command catalogue.

## 14. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Codex changes the private catalogue. | Keep one adapter-owned catalogue with exact tests and an identified Codex source snapshot. |
| Public Realtime voices are mistaken for AVAS voices. | Name the protocol scope in code/tests and keep V2 values out of this catalogue. |
| An invalid stored value causes an opaque provider 403. | Validate at mutation and call construction before authentication or SDP. |
| A settings update changes an active call unexpectedly. | Persist and reuse the call-start snapshot across recovery. |
| UI and CLI drift. | Serve one backend catalogue and validate through one operator-service seam. |
| A database enum blocks future catalogue removal. | Store bounded text; validate membership in application/provider code. |
| Hard-cut deployment starts with voice disabled. | Require and document explicit `PANDA_LIVE_VOICE_ENABLED=true` in deployment. |
| Historical calls appear to use the new default. | Leave historical session voice `NULL` rather than fabricating provenance. |
| Discord ownership leaks back into shared voice code. | Resolve the agent in worker assembly, then pass only the selected voice into the generic session/provider contract. |

## 15. Non-goals

- Dynamic voice discovery from OpenAI or Codex app-server.
- A runtime dependency on the Codex repository or binary.
- Public Realtime V2 voice support.
- Changing the GPT-Live model, OAuth flow, endpoint or protocol version.
- Mid-call voice switching.
- Per-session, per-connector or per-participant voice overrides.
- Voice preview audio or invented voice descriptions.
- Telegram, WhatsApp or custom-call implementation.
- Compatibility with removed environment variables.

## 16. Definition of done

The migration is complete when:

1. every agent has one durable, validated live voice;
2. existing agents migrate to `cove` without reading the legacy environment;
3. every new live session records and reports its effective voice;
4. active calls retain that snapshot through setting changes and recovery;
5. OpenAI Live has one exported V1/V3 catalogue and no duplicate defaults;
6. Control and CLI list and mutate the same values;
7. the voice lab consumes the same catalogue and records the selected value;
8. all four old Discord-prefixed variables are absent from code and docs;
9. the channel-neutral kill switch remains disabled by default;
10. focused tests, typecheck, import law, Control build, real-Postgres checks
    and disposable-database smoke pass; and
11. two agents can join calls with different verified voice snapshots.

## References

OpenAI (2026) *Realtime API reference: Realtime audio output configuration*.
Available at:
<https://developers.openai.com/api/reference/python/resources/realtime>
(Accessed: 31 August 2026).

OpenAI Codex (2026a) *Realtime voice catalogue*. `codex-rs/protocol/src/protocol.rs`,
commit `2c4a95736bea64256a50f7b8506bd33c181cc85a`, 27 August. Local source
checkout.

OpenAI Codex (2026b) *Realtime conversation AVAS defaults and voice validation*.
`codex-rs/core/src/realtime_conversation.rs`, commit
`2c4a95736bea64256a50f7b8506bd33c181cc85a`, 27 August. Local source checkout.

Panda Agent (2026a) *ADR 0001: Runtime architecture guardrails*. Available at:
[`docs/developers/adr/0001-runtime-architecture-guardrails.md`](../developers/adr/0001-runtime-architecture-guardrails.md)
(Accessed: 31 August 2026).

Panda Agent (2026b) *Live voice*. Available at:
[`docs/developers/live-voice.md`](../developers/live-voice.md) (Accessed: 31
August 2026).

Panda Agent (2026c) *OpenAI Live wire protocol*. Available at:
[`src/integrations/providers/openai-live/wire.ts`](../../src/integrations/providers/openai-live/wire.ts)
(Accessed: 31 August 2026).

Panda Agent (2026d) *OpenAI Live provider definition*. Available at:
[`src/integrations/providers/openai-live/provider.ts`](../../src/integrations/providers/openai-live/provider.ts)
(Accessed: 31 August 2026).

Panda Agent (2026e) *Discord voice manager*. Available at:
[`src/integrations/channels/discord/voice-manager.ts`](../../src/integrations/channels/discord/voice-manager.ts)
(Accessed: 31 August 2026).

Panda Agent (2026f) *Database migrations*. Available at:
[`docs/developers/database-migrations.md`](../developers/database-migrations.md)
(Accessed: 31 August 2026).

Panda Agent (2026g) *Live voice domain records*. Available at:
[`src/domain/live-voice/types.ts`](../../src/domain/live-voice/types.ts)
(Accessed: 31 August 2026).

Panda Voice Lab (2026) *Standalone local voice regression harness*. Adjacent
development checkout at `../panda-voice-lab`. Unpublished internal tooling.
