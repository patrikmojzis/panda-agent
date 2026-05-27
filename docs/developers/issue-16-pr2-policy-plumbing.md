# Issue #16 PR2 — Policy plumbing and hidden durable subagent seam

This note records the second foundation slice for issue #16. It hardens policy and storage, then adds an internal durable subagent path for tests/future wiring. It does **not** change the model-facing `spawn_subagent` behavior and does **not** remove `worker_spawn`.

## Profile store hardening

`runtime.subagent_profiles` now treats global/built-in slugs as reserved:

- Global rows (`agent_key IS NULL`) win over agent-scoped custom rows.
- Custom profiles cannot claim a slug already held globally.
- Global seeding refuses to trample an existing agent-scoped custom collision; that needs an operator migration.
- Profile UPSERTs use the matching partial unique index conflict target instead of a lookup-then-insert race.
- UPSERTs take a transaction-scoped advisory lock keyed by normalized slug so cross-scope reservation stays atomic.
- Agent-scoped lookup orders global rows first as a deterministic safety net if legacy collisions exist.

## Operation-aware `agent_skill` policy

`ExecutionToolPolicy` has a narrow `agentSkill.allowedOperations` field with `load`, `set`, and `delete` operations.

Enforcement rules:

- `AgentSkillTool` checks the operation policy before touching the skill store.
- Subagent sessions fail closed for missing or malformed operation policy.
- Main and legacy non-subagent sessions keep absent-policy compatibility.
- Existing skill allowlist policy still controls which skill keys can be loaded; mutation still requires all-agent skill policy.

Tool groups changed accordingly:

- `core` may include raw `agent_skill`, but grants `load` only.
- `skill_maintenance` grants only `agent_skill` with `load,set,delete`.
- `operate` still grants broad operational tools and full skill operations.
- Built-in `skill_maintainer` uses `core + workspace_read + memory + skill_maintenance`, not broad `operate`.

## Hidden durable subagent seam

This PR adds internal-only durable subagent primitives:

- `AgentSessionKind` accepts `subagent`.
- Subagent session metadata is versioned under `metadata.subagent` and includes profile snapshot, resolved policy, execution mode, parent session, task, context, and optional environment id.
- `SubagentSessionService` can create durable `subagent` sessions/threads, enqueue a handoff, bind A2A both directions before handoff, and clean up created session/thread rows on failure.
- `agent_workspace` subagents use the agent workspace fallback with snapshotted credential/skill/tool policy.
- `isolated_environment` subagents attach only to an existing ready same-agent disposable environment. Attach is ready-only: no create, restart, or stop.

This seam is intentionally hidden. User/model docs must not advertise it until the later spawn hard-cut slice wires it as the model-facing durable `spawn_subagent` path.

## Runtime enforcement

Subagent thread definitions:

- Use the snapshotted profile prompt as instructions.
- Add `Subagent Runtime Context` with task/parent/message-agent guidance.
- Filter tools by resolved `ExecutionToolPolicy`.
- Always deny `worker_spawn`.
- Do not include the default main prompt, worker prompt/context, session briefing/transcript, or Workers Context unless explicitly requested and tested.

Worker behavior remains a separate legacy path for now.
