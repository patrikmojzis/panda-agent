# Runner Isolation and Collaboration Workspace Hardening

- **Date:** 28 August 2026
- **Status:** scoped runner authentication, control-network isolation,
  per-runner networks and immutable readable-file handoff implemented. The
  bounded legacy migration bearer, writable-path hardening and destination-
  filtered workspace egress remain migration work.
- **Owner:** Panda runtime and deployment
- **Decision state:** target direction agreed; `/workspace/shared` remains a
  supported collaboration path

## Abstract

Panda depends on remote runners for model-directed shell execution. At the
pre-hardening baseline, runner authentication was optional, the same
bearer may be reused across runners, and persistent or disposable runners may
share network reachability. A compromised agent workspace could therefore use a
reachable runner as a command-execution bridge into another agent's filesystem,
credentials or host-mounted data. Live recon confirmed that this was an
exploitable execution path rather than a purely theoretical concern (Mojzis and
Codex, 2026).

This plan replaces the global runner bearer with a unique token derived for each
agent or execution environment from a Core-only master key. It separates
runner-control and untrusted-workspace networks, gives persistent runners
per-agent network boundaries, and preserves existing A2A, file-delivery,
background-job and subagent behaviour.

The original proposal to remove `/workspace/shared` is rejected. Panda has a
real workflow in which multiple subagents collaborate in one Git repository at
that path. The directory will instead become an explicit **collaboration trust
domain**: authorised collaborators may read and write it, while unrelated
agents, host data, credentials, transcripts and control endpoints remain
outside its boundary.

## 1. Problem statement

The deployment must support a company agent on a local Mac mini without giving
prompt-injected or otherwise compromised model execution an ambient route to:

1. another agent's runner or filesystem;
2. another session's transcript or durable state;
3. Core, connector, provider, database or Git credentials;
4. the host user's home directory, Keychain, SSH agent or Codex state;
5. the Docker control socket or other host-control interfaces; or
6. unrelated collaboration workspaces.

At the same time, the hardening must preserve:

- foreground and background Bash;
- named and fallback execution targets;
- A2A text and file delivery;
- channel file sends;
- `panda subagent spawn` and subagent A2A progress;
- disposable isolated environments;
- one shared, writable Git worktree under `/workspace/shared`; and
- remote runner operation where Unix sockets are unavailable.

Containers alone are not a host-security boundary when sensitive host paths are
mounted into them. The practical objective is therefore to make the runner's
authority explicit and narrow, then recommend a dedicated macOS user as the
outer host boundary. A dedicated Linux VM remains stronger containment, but it
is not required for this implementation.

## 2. Pre-implementation findings

### 2.1 Runner authentication is optional and global

At the recon baseline, the runner skipped bearer validation when
`BASH_SERVER_SHARED_SECRET` was empty. The stack generator passed one optional global value into persistent
runners and the disposable environment manager (Panda Agent, 2026f; Panda
Agent, 2026g). This creates two related failure modes:

- an unset value leaves mutation endpoints unauthenticated; and
- a leaked value authenticates to every runner that shares it.

The existing agent-key and path-scoping headers are useful target-integrity
checks, but they are not a substitute for a runner-specific credential (Panda
Agent, 2026h).

### 2.2 Reachability creates lateral execution

Core, persistent runners, the environment manager, disposable control runners,
workspaces and the browser runner currently use overlapping Docker networks.
The disposable manager supplies the same configured network to both the control
and workspace containers (Panda Agent, 2026i). A workspace that can address a
runner and authenticate with the shared bearer can ask that runner to execute a
command in its mounted filesystem.

Non-published ports and a healthy container do not provide isolation. The live
review confirmed unauthorised cross-runner execution on the deployed path
(Mojzis and Codex, 2026).

### 2.3 The command channel is a compatibility dependency

Agent-facing `panda ...` commands run through a separate, short-lived command
lease. The shim requires either `PANDA_COMMAND_URL` or `PANDA_COMMAND_SOCKET`
plus a lease token. Native A2A file sends stream client-local bytes through
`/commands/files?for=a2a.send` before queueing delivery (Panda Agent, 2026j).

Consequently, removing workspace network access before establishing the Unix
socket path would break A2A file sends, subagent spawn, channel commands and
other CLI Tools. Runner-control isolation and command access are different
problems and must remain different transports.

### 2.4 A2A itself is not runner-to-runner traffic

A2A is session-to-session durable delivery. Core resolves staged uploads into
recipient media storage, creates an `a2a_message` runtime request and submits it
to the recipient session's current thread (Panda Agent, 2026c; Panda Agent,
2026k). Neither sender nor recipient requires network access to the other's
runner.

Subagent creation similarly creates a durable session and thread, attaches an
isolated environment when requested, creates directional A2A bindings and
queues the initial handoff (Panda Agent, 2026l). Network isolation is compatible
with this model as long as every executing workspace retains its own command
transport.

### 2.5 `/workspace/shared` is both required and over-broad

Persistent runners and Core currently mount the same configured `SHARED_ROOT`
at `/workspace/shared` (Panda Agent, 2026g; Panda Agent, 2026m). This supports the
existing shared-Git-worktree collaboration flow, but it also means every runner
receiving the mount belongs to one filesystem trust domain.

The current fallback path resolver does not assign `/workspace/shared` a
containment root. In a deployment where Core can also see sensitive paths, a
symlink created inside the shared tree may cause a Core-side file consumer to
resolve outside the intended workspace (Panda Agent, 2026n). This must be fixed
without changing the model-visible path.

### 2.6 Prioritised risk register

| Priority | Finding | Status |
| --- | --- | --- |
| P0 | Unauthenticated runner remote command execution | Confirmed in source and live recon when the shared secret is absent. |
| P0 | Cross-runner execution through shared reachability and bearer | Confirmed live; direct privacy boundary failure. |
| P1 | One leaked global bearer authorises multiple runners | Confirmed design weakness. |
| P1 | `/workspace/shared` exposes every mounted member to mutual read/write and Git poisoning | Required workflow; convert to an explicit accepted trust domain. |
| P1 | Core file consumers lack a shared-root containment boundary | Confirmed source weakness; symlink escape must fail closed. |
| P1 | Running Panda under a personal host user increases Core/host compromise impact | Deployment risk; dedicated user is the practical non-VM boundary. |
| P2 | Same-host command HTTP creates a compatibility dependency on shared networking | Confirmed; migrate to Unix socket before network separation. |
| Accepted | Collaborators can overwrite or delete the same Git worktree | Inherent in the requested workflow; protect recoverability, not mutual secrecy. |

## 3. Security decision

The implementation will use five independent controls:

1. **Unique runner authentication:** one derived bearer per persistent agent or
   disposable execution environment.
2. **Control-network isolation:** untrusted workspaces cannot address any Bash
   control runner.
3. **Execution-owned command access:** same-host workspaces use a scoped Unix
   command socket; remote runners use authenticated HTTP command access.
4. **Explicit collaboration membership:** `/workspace/shared` is mounted only
   into authorised collaborators and is never treated as a private boundary
   between those collaborators.
5. **Host and secret minimisation:** runners receive only the paths and
   per-operation credentials required for their work.

Prompt instructions are not an access-control mechanism. Authority must come
from tokens, network membership, database roles, command leases and filesystem
mounts (Panda Agent, 2026a; Panda Agent, 2026b).

## 4. Trust model

### 4.1 Trusted components

- Panda Core and its runner-token master key;
- the environment manager for runner lifecycle only;
- the command lease issuer and verifier;
- Postgres roles and scoped session views; and
- operator-owned deployment configuration.

### 4.2 Untrusted components

- model-generated Bash and every child process;
- persistent and disposable workspaces;
- repository contents, Git hooks and project scripts;
- inbound channel and A2A content;
- browser content; and
- any file written by an agent.

### 4.3 Collaboration-domain exception

All runners or subagents with read-write access to the same
`/workspace/shared` repository are mutually trusted **for that repository**.
They may observe unfinished changes, alter Git metadata, delete files or poison
instructions consumed by another collaborator. The system cannot preserve one
shared writable worktree while also isolating its collaborators from each
other.

This exception does not grant collaborators access to:

- another agent's home directory;
- runner tokens or command lease tokens;
- transcripts or raw runtime tables;
- Core credentials;
- other collaboration roots; or
- another runner's control endpoint.

## 5. Target architecture

### 5.1 Runner token derivation

Core owns a dedicated master key, separate from `CREDENTIALS_MASTER_KEY` and
command-lease keys:

```text
PANDA_RUNNER_TOKEN_MASTER_KEY
```

The key must be at least 32 random bytes, loaded from an operator-owned secret
file or platform secret manager. It must not be present in runners, workspaces,
Postgres, prompts, logs, generated Compose or command output.

Core derives tokens with HMAC-SHA-256 and explicit domain separation:

```text
token = base64url(HMAC-SHA-256(
  master,
  "panda-runner-auth-v1\0" + scopeKind + "\0" + agentKey + "\0" + scopeId
))
```

Canonical scopes are:

| Runner kind | `scopeKind` | `scopeId` |
| --- | --- | --- |
| Persistent fallback runner | `persistent-agent` | normalised `agentKey` |
| Named persistent environment | `execution-environment` | environment ID |
| Disposable control runner | `execution-environment` | environment ID |
| Environment setup request | same as its target | same as its target |

The scope follows the physical execution boundary, not a session alias. Several
sessions may bind the same canonical environment and therefore use the same
runner token. Registering one physical runner URL as several supposedly
isolated environment IDs must be rejected or converged onto one canonical
environment record; otherwise the database would describe isolation that the
filesystem and process boundary do not provide.

The agent key remains in every scope even when the environment ID is globally
unique. Runners receive only their derived token and compare it in constant
time. Missing or malformed authentication fails closed on every mutation
endpoint. `/health` may remain unauthenticated on its private network, but its
result continues to mean only **reachable**, not authorised.

Derived tokens are not application data. They must not be stored in Postgres or
long-lived application records. Prefer runtime secret mounts for persistent
runners and control-only secret delivery for disposable runners; passing the
token through container environment metadata is a temporary migration measure,
not the target.

### 5.2 Runner transport

Add one deep integration module, `RunnerTransport`, as the only Core-side owner
of runner HTTP requests. It accepts a resolved target containing the agent key,
environment ID when present, URL and URL template. It owns:

- token derivation and authorisation headers;
- current agent-key, path-scoped and expected-path headers;
- URL construction;
- foreground `exec` and `abort`;
- background `start`, `status`, `wait` and `cancel`;
- setup-script execution;
- bounded network timeouts;
- response parsing and redacted diagnostics; and
- optional health probing.

The module belongs in `src/integrations/shell`; runtime assembly injects it into
the foreground executor, background runner and setup runner. The refactor must
not move shell or environment policy into `app` or `kernel` (Panda Agent
Architecture Team, 2026).

Background job handles retain the resolved runner URL and headers for their
entire live lifecycle. A master-key rotation or runner recreation therefore
requires a bounded drain or cancellation of active jobs before the old token is
withdrawn.

### 5.3 Disposable network topology

Use three distinct network roles:

```text
execution_manager_net
  Core <-> environment manager

runner_control_net
  Core <-> environment manager <-> disposable control runners

workspace_<environment-id>_net
  disposable workspace only, plus explicitly approved application egress
```

The untrusted workspace is never attached to `runner_control_net`. The control
runner does not rely on direct workspace HTTP reachability: it delegates
workspace process execution through the environment manager's Docker execution
seam. Core is not attached to per-environment workspace networks.

The environment manager must create, label, attach and remove dynamic workspace
networks idempotently. Cleanup validates Panda ownership labels before removing
containers or networks. Partial creation failure must clean both container
roles and the environment network. Environment ownership and attachment remain
session-scoped even though the runner and container are separate concepts
(Panda Agent, 2026d).

### 5.4 Persistent runner topology

Until persistent runners are replaced by managed two-container environments,
each persistent agent receives a separate private network:

```text
runner_panda_net: Core + panda runner
runner_luna_net:  Core + luna runner
```

No runner joins another agent's network. The browser runner receives its own
network and token boundary. Runners do not join database, connector, control UI
or public ingress networks unless a separately reviewed feature requires it.
The network may retain outbound NAT because the shared Git workflow needs
GitHub and package access; where privacy requirements demand it, an egress
policy denies private networks and configured database endpoints while allowing
the reviewed development destinations. Do not mark this network `internal`
until those workflows have an explicit proxy or alternative route.

For statically declared agents, the stack generator creates the networks. Any
future dynamic persistent-runner feature must connect Core and the exact runner
atomically rather than falling back to a shared runner network.

### 5.5 Command transport

Same-host persistent and disposable workspaces use the existing Unix command
socket. The socket mount contains no runner-control token; each run still
receives a short-lived command lease scoped by agent, session, run, environment
and allowed command policy.

Remote runners that cannot mount the socket retain authenticated HTTP command
access on a command-only route. They must not join `runner_control_net`, and the
HTTP command endpoint must remain inaccessible to unrelated workspaces.

The command transport migration precedes network disconnection. A workspace is
not considered ready until a real scoped command succeeds through its intended
transport.

### 5.6 Collaboration workspace

The model-visible contract remains:

```text
/workspace/shared
```

The source must be the narrowest operator-approved directory. If the workflow
needs one repository, mount that repository or its dedicated collaboration
root, not the user's entire `Documents` directory.

For the current single shared root, deployment configuration identifies the
authorised agent keys. A proposed surface is:

```text
SHARED_ROOT=/Users/<dedicated-user>/company-workspaces
PANDA_SHARED_WORKSPACE_AGENTS=panda
```

This is deployment authority, not model input. The environment manager may
attach the same root to an isolated subagent only when its parent execution
environment is already a member. The membership decision is recorded in
execution-environment metadata as an opaque workspace ID; arbitrary host paths
are never accepted from agent commands.

Behaviour by execution type:

| Execution type | Shared repository behaviour |
| --- | --- |
| Main persistent agent | Existing path and read-write behaviour remain. |
| `agent_workspace` subagent | Inherits the same runner and path; no workflow change. |
| Authorised isolated subagent | Receives an explicit read-write bind of the same collaboration root. |
| Unauthorised agent/subagent | Receives no mount or a private empty workspace, never the collaboration root. |

The shared mount is a data collaboration path only. Runner tokens, command
access files, credential files, output captures and environment metadata must
remain outside it.

### 5.7 Core file access and symlink containment

Core-side commands must resolve `/workspace/shared/...` through the current
agent/session's authorised collaboration root. The resolver assigns that root
as `containmentRoot`, resolves symlinks and rejects any path whose resolved
target escapes the root.

The readable-file boundary materialises bytes into an owner-private Core spool
before A2A or channel delivery. Core verifies that the opened inode is the
contained file before copying it, caps the snapshot at 100 MiB, and prevents
later symlink or file replacement from changing the delivered bytes. Bounded
retention and richer provenance metadata remain follow-up work.

Writable commands use an equivalent "open beneath collaboration root" boundary
and reject symlink escapes. The user-facing path and Git workflow do not change.

### 5.8 Git and credential policy

The shared repository is untrusted input even though it is intentionally
writable. The deployment therefore applies these rules:

- no credential-bearing remote URLs in `.git/config`;
- no host `SSH_AUTH_SOCK`, `.ssh`, Keychain or general Git credential-helper
  mount;
- repository-scoped, short-lived GitHub credentials only when push is needed;
- credential authorisation before decryption and process-only injection;
- no credential values in prompts, transcripts, Git config, logs or files;
- Git hooks and executable project scripts are considered arbitrary code; and
- recoverable host snapshots protect uncommitted and untracked work from a
  destructive collaborator.

If authenticated Git operations later require stronger protection from
repository-controlled hooks, add a narrow SCM command broker. That is a
follow-up, not a prerequisite for preserving the current local collaboration
workflow.

## 6. Privacy impact

### 6.1 Other sessions and transcripts

Runner tokens authenticate only Core-to-runner transport. They grant no direct
database or transcript authority. Model-readable persistence remains behind
session-scoped views and explicit command authority. Runner networks have no
route to Postgres.

A2A exposes only explicitly delivered content and authorised A2A history. A
shared Git worktree does not imply transcript sharing.

### 6.2 Agent homes

Each persistent runner mounts only its agent home plus explicitly authorised
collaboration roots. It does not mount `$HOME/.panda/agents` as a parent and
does not receive other agent directories. Isolated workspaces receive only
their workspace, inbox, artifacts and optional collaboration root.

### 6.3 Credentials

Core retains provider, database, connector, Git and credential-master secrets.
The runner receives only credentials authorised for the current foreground
process or background-job snapshot. The control runner token is never exposed
to the workspace process.

An authorised process can misuse credentials deliberately granted to it. The
protection is therefore least-privilege selection, short lifetime, repository
or account scoping, redaction and revocation—not a claim that arbitrary Bash can
be made harmless.

### 6.4 Host machine

The runner cannot access an unmounted host path merely because it knows the
path's macOS name. The remaining host exposure is the exact set of bind mounts
and host-control sockets. The deployment must not mount the Docker socket into
Core or runners and must not give the workspace a broad home-directory bind
(Panda Agent, 2026e).

For the Mac mini, run Panda under a dedicated non-admin macOS account. That
account owns only Panda state and the approved company collaboration roots.
This contains a Core or container escape better than running Panda under the
operator's personal account, while retaining the existing local-machine
workflow.

## 7. Compatibility assessment

| Workflow | Target compatibility | Required condition |
| --- | --- | --- |
| A2A text | Preserved | Workspace command transport remains usable. |
| A2A file attachment | Preserved | Socket/HTTP upload reaches Core before delivery. |
| A2A receive after `/reset` | Preserved | Delivery continues to resolve the current session thread. |
| Channel file send | Preserved | Core resolver maps and contains authorised shared paths. |
| `agent_workspace` spawn | Preserved | Persistent runner retains command socket and shared mount. |
| Isolated subagent spawn | Preserved | Manager attaches command socket and authorised workspace. |
| Subagent progress/completion | Preserved | Child retains scoped `a2a.send` command authority. |
| Foreground Bash/abort | Preserved | `RunnerTransport` derives token for resolved target. |
| Background status/wait/cancel | Preserved | Handle retains original target and token for its lifetime. |
| Environment setup | Preserved | Setup runner uses the environment-scoped token. |
| Shared Git worktree | Preserved | All intended collaborators join the same explicit trust domain. |
| Cross-agent ambient sharing | Intentionally removed | Non-members use A2A attachments or an explicitly shared domain. |
| Existing remote runner | Migration required | Re-register/restart with its derived token and command route. |

## 8. Component changes

### 8.1 Configuration and secret loading

- Add `PANDA_RUNNER_TOKEN_MASTER_KEY_FILE` or equivalent platform-secret input.
- Add explicit shared-workspace membership configuration.
- Keep `BASH_SERVER_SHARED_SECRET` only during the compatibility window.
- Reject startup when scoped authentication is required but the master key or
  runner token is missing.
- Keep master and derived tokens out of credential listings and diagnostics.

### 8.2 Shell integration

- Add `src/integrations/shell/runner-transport.ts`.
- Move foreground, background and setup runner calls behind it.
- Replace optional shared-secret headers with required target-derived headers.
- Preserve target/path validation and current protocol response shapes.
- Keep `/health` semantics explicit and separate from authenticated readiness.

### 8.3 Runner server

- Read one runner token from a runtime secret source.
- Fail closed on every POST endpoint when it is absent.
- Compare bearer values in constant time.
- Never echo, log or include the token in health or error responses.
- Keep `BASH_SERVER_AGENT_KEY` target validation.

### 8.4 Environment manager and Docker client

- Replace the single disposable network option with explicit control and
  workspace network inputs.
- Add labelled network create/connect/disconnect/remove operations.
- Mount control-runner secrets only into the control container.
- Store disposable runner token files in a manager-only root outside every
  environment and persistent-runner mount.
- Mount the command socket and collaboration root only into authorised
  workspaces.
- Do not attach workspaces to the control network.
- Clean partial networks and containers idempotently.

### 8.5 Stack generator

- Create one private network per persistent agent.
- Keep Core on each declared persistent-runner network.
- Create a separate disposable control network.
- Default same-host command transport to the Unix socket.
- Mount the collaboration root only into authorised agent services.
- Stop emitting the global runner secret after migration.

### 8.6 Path and file commands

- Add collaboration-root mapping to runtime path context.
- Apply containment to readable and writable shared paths.
- Add immutable materialisation to A2A and channel file consumers.
- Preserve `/workspace/shared/...` in command inputs and user-visible output.

### 8.7 Documentation and operator surfaces

- Update Remote Bash and disposable-environment documentation.
- Change runner attach output from a shared secret to a derived target token.
- Document that health means reachability only.
- Document collaboration-domain membership and its mutual-trust consequence.
- Add migration diagnostics that list runners still using legacy auth without
  printing any credential.

## 9. Migration plan

### Phase 0: Immediate containment

1. Set a strong non-empty legacy `BASH_SERVER_SHARED_SECRET` on Core and every
   current runner until scoped tokens ship.
2. Confirm no runner port is publicly published.
3. Remove runner reachability to Postgres and unrelated control services.
4. Run Panda under a dedicated, non-admin macOS user when operationally ready.
5. Set `SHARED_ROOT` to the narrow company workspace root, not a personal
   Documents or home directory.

This reduces exposure but does not solve shared-secret lateral execution.

### Phase 1: Freeze compatibility contracts

Before refactoring, add end-to-end tests for:

- foreground Bash and abort;
- background start/status/wait/cancel;
- named and fallback targets;
- A2A text and file delivery;
- channel file delivery from agent home and `/workspace/shared`;
- agent-workspace and isolated subagent spawning;
- child A2A progress and completion;
- environment setup scripts; and
- concurrent Git reads and writes in the shared worktree.

Add negative tests for cross-agent runner access and shared-path symlink escape.

### Phase 2: Introduce `RunnerTransport`

Move all current runner requests behind the transport without changing tokens,
networks or filesystem mounts. Focused tests must show byte-for-byte compatible
protocol inputs and outputs, including path-scoped runner URLs.

### Phase 3: Add scoped authentication

1. Load the Core-only master key.
2. Derive tokens for every resolved target.
3. Let runners accept their scoped token and the legacy secret during a bounded
   compatibility window.
4. Recreate disposable and persistent runners one at a time.
5. Drain or cancel active background jobs before each token change.
6. Re-register remote named runners and verify authenticated exec, not merely
   health.
7. Record only migration status, never tokens.

Exit gate: every active runner accepts its own token and rejects another
runner's token.

### Phase 4: Migrate the command channel

1. Enable the Unix command socket for same-host persistent runners and
   disposable workspaces.
2. Refresh command-access files at run start.
3. Execute real command, A2A file and subagent-spawn probes from each environment
   class.
4. Retain HTTP only for explicitly remote runners.

Exit gate: no same-host workspace depends on reaching Core command HTTP over a
shared Docker network.

### Phase 5: Split disposable networks

1. Create `runner_control_net`.
2. Attach Core, manager and control runners.
3. Create one workspace network per disposable environment.
4. Remove workspace membership from the old shared runner network.
5. Prove workspace-to-control TCP connection attempts fail.
6. Verify environment creation, setup, Bash, A2A and cleanup.

### Phase 6: Split persistent networks

1. Generate one private network per declared agent.
2. Attach only Core and that agent's runner.
3. Recreate runners sequentially.
4. Verify authenticated foreground/background execution and Git collaboration.
5. Remove the legacy `runner_net` from persistent runners.

### Phase 7: Scope the collaboration workspace

1. Declare the existing shared root as a named collaboration domain.
2. Declare its authorised agent keys.
3. Keep `/workspace/shared` unchanged for those members.
4. Add explicit authorised mounting for isolated collaborators when required.
5. Deny the mount to non-members.
6. Add Core path containment and symlink-escape tests.
7. Move cross-domain file exchange to A2A attachments.

This phase removes ambient sharing, not the collaboration workflow.

### Phase 8: Hard cut

1. Remove legacy-secret acceptance.
2. Remove `BASH_SERVER_SHARED_SECRET` from Core, manager, runners, examples and
   docs.
3. Fail startup on missing scoped runner authentication.
4. Remove obsolete shared network configuration.
5. Run the complete compatibility and adversarial suite.

## 10. Verification gates

### 10.1 Functional gates

- A2A text and 1-byte, ordinary and maximum-size file sends succeed through the
  Unix socket.
- Recipient delivery survives a sender or recipient `/reset`.
- Parent and child subagents exchange progress and completion.
- Two authorised subagents can inspect and modify the same Git worktree.
- Channel sends can read files inside the collaboration root.
- Foreground abort and every background-job action target the original runner.
- Environment setup and cleanup work after network recreation.
- Remote HTTP command transport remains functional for an explicitly remote
  runner.

### 10.2 Security gates

- Missing authentication returns `401` or `403`; it never executes.
- A token for agent A fails against agent B.
- A token for environment A fails against environment B.
- A workspace cannot resolve or connect to any control runner.
- A persistent runner cannot address another persistent runner.
- Runner and workspace egress policy denies configured Postgres endpoints while
  preserving the reviewed GitHub and package destinations.
- Workspaces cannot read the master key or derived control token.
- Non-member agents cannot see the collaboration mount.
- A symlink in `/workspace/shared` cannot make Core read or write outside the
  collaboration root.
- Tokens do not appear in Postgres, transcripts, logs, command output or
  generated Compose.
- No Docker socket, host SSH agent, personal home or other agent home is mounted
  into a workspace.

### 10.3 Operational gates

- Runner recreation is documented and repeatable.
- Key rotation has a tested drain, dual-acceptance and revocation procedure.
- Network and container cleanup survives partial failure.
- Operators can identify legacy-auth runners without seeing secrets.
- Rollback never restores unauthenticated mutation endpoints.

## 11. Rollback strategy

Each phase is independently reversible until the hard cut:

- `RunnerTransport` can continue using the legacy bearer while retaining one
  request implementation.
- Scoped-token rollout may temporarily accept both scoped and legacy values.
- Command socket migration may return an explicitly remote runner to HTTP.
- Network splitting may reconnect the exact runner and Core network while the
  underlying token remains scoped.
- Collaboration-root scoping may restore membership for an intended
  collaborator without restoring access to every agent.

Rollback must never use an empty secret, publish a runner port publicly, mount
the Docker socket, or expose the runner-token master to a workspace.

## 12. Definition of done

The hardening is complete when:

1. every mutation request to every runner requires its unique scoped token;
2. Core is the only component holding the master key;
3. no workspace can address a control runner or Postgres;
4. persistent runners cannot address each other;
5. same-host agent commands use the Unix socket;
6. A2A, files, subagents, background jobs and setup pass compatibility tests;
7. `/workspace/shared` continues to support the authorised collaborative Git
   workflow;
8. non-members cannot mount or resolve that collaboration root;
9. Core file consumers cannot escape it through symlinks or path races;
10. runner and Git credentials remain scoped, short-lived and absent from the
    shared tree; and
11. the Mac mini deployment can run under a dedicated non-admin user without
    requiring a Linux VM.

## 13. Non-goals and accepted residual risk

- This plan does not isolate collaborators from one another inside one writable
  Git worktree.
- It does not make arbitrary Bash safe after explicitly granting a credential
  or network destination.
- It does not protect against compromise of Panda Core, the dedicated host user
  or the operating-system kernel.
- It does not redesign A2A, session/thread ownership or the command catalog.
- It does not require per-subagent Git worktrees; those may improve collision
  handling later but would change the current collaboration model.
- It does not replace a VM as the strongest available host boundary.

## References

Mojzis, P. and Codex (2026) *Pre-hardening runner and local-host privacy recon*.
Unpublished internal live review and design discussion, 25–28 August.

Panda Agent (2026a) *Developer vocabulary*. Available at:
[`docs/developers/vocabulary.md`](../developers/vocabulary.md) (Accessed: 28
August 2026).

Panda Agent (2026b) *ADR 0001: Runtime architecture guardrails*. Available at:
[`docs/developers/adr/0001-runtime-architecture-guardrails.md`](../developers/adr/0001-runtime-architecture-guardrails.md)
(Accessed: 28 August 2026).

Panda Agent (2026c) *A2A messaging*. Available at:
[`docs/users/a2a.md`](../users/a2a.md) (Accessed: 28 August 2026).

Panda Agent (2026d) *Execution environments*. Available at:
[`docs/developers/execution-environments.md`](../developers/execution-environments.md)
(Accessed: 28 August 2026).

Panda Agent (2026e) *Remote Bash/Bash Server*. Available at:
[`docs/users/remote-bash.md`](../users/remote-bash.md) (Accessed: 28 August
2026).

Panda Agent (2026f) *Bash runner server*. Available at:
[`src/integrations/shell/bash-runner.ts`](../../src/integrations/shell/bash-runner.ts)
(Accessed: 28 August 2026).

Panda Agent (2026g) *Docker stack generator*. Available at:
[`scripts/docker-stack.sh`](../../scripts/docker-stack.sh) (Accessed: 28 August
2026).

Panda Agent (2026h) *Bash executor*. Available at:
[`src/integrations/shell/bash-executor.ts`](../../src/integrations/shell/bash-executor.ts)
(Accessed: 28 August 2026).

Panda Agent (2026i) *Docker execution environment manager*. Available at:
[`src/integrations/shell/docker-execution-environment-manager.ts`](../../src/integrations/shell/docker-execution-environment-manager.ts)
(Accessed: 28 August 2026).

Panda Agent (2026j) *Agent command shim*. Available at:
[`scripts/agent-command-shim/panda`](../../scripts/agent-command-shim/panda)
(Accessed: 28 August 2026).

Panda Agent (2026k) *A2A outbound and request handling*. Available at:
[`src/integrations/channels/a2a/outbound.ts`](../../src/integrations/channels/a2a/outbound.ts)
and
[`src/integrations/channels/a2a/request-handler.ts`](../../src/integrations/channels/a2a/request-handler.ts)
(Accessed: 28 August 2026).

Panda Agent (2026l) *Subagent session service*. Available at:
[`src/app/runtime/subagent-session-service.ts`](../../src/app/runtime/subagent-session-service.ts)
(Accessed: 28 August 2026).

Panda Agent (2026m) *Remote Bash external database Compose example*. Available
at:
[`examples/docker-compose.remote-bash.external-db.yml`](../../examples/docker-compose.remote-bash.external-db.yml)
(Accessed: 28 August 2026).

Panda Agent (2026n) *Panda runtime path context*. Available at:
[`src/app/runtime/panda-path-context.ts`](../../src/app/runtime/panda-path-context.ts)
(Accessed: 28 August 2026).

Panda Agent Architecture Team (2026) *Panda architecture*. Available at:
[`docs/developers/architecture.md`](../developers/architecture.md) (Accessed: 28
August 2026).
