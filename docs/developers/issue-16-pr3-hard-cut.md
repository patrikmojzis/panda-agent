# Issue #16 PR3 Durable `spawn_subagent` Hard Cut

PR3 makes `spawn_subagent` the single model-facing delegation surface. It now
creates a durable `agent_sessions.kind = "subagent"` session/thread, binds
parent↔subagent A2A, enqueues the handoff, and returns immediate handoff
metadata (`status`, `sessionId`, `threadId`, profile/execution/env). It does not
return a background `jobId`.

Model-facing schema is intentionally strict: required `prompt`; optional
`profile`, `context`, `execution`, `environmentId`, `credentialAllowlist`, and
`toolGroups`. Old fields such as `role`, `task`, `model`, raw tool/skill
allowlists, TTLs, and `transcriptMode` are rejected rather than adapted.

the legacy worker-spawn tool is no longer model-facing. Historical worker sessions, metadata,
purge support, and internal runtime-client paths remain for compatibility, but
new model delegation should use durable subagents.

Environment lifecycle stays separate: `panda environment ...` commands remain
command-facing, while `spawn_subagent` never creates, restarts, or stops
environments. `isolated_environment` requires an existing ready same-agent
disposable environment owned by the parent session.

Nested durable subagents are denied in PR3, even when a subagent profile requests
`operate`. Recursion needs a later explicit depth/policy design.

Decision chain: PR1 added profile/tool-group foundations; PR2 added hidden
durable subagent session plumbing; PR3 exposes that durable path and hard-cuts
the old background/in-memory delegation contract.
