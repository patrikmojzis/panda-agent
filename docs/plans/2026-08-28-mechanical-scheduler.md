# Mechanical Scheduler

- **Date:** 28 August 2026
- **Status:** discovery plan; not implementation authority
- **Owner:** Panda product/runtime
- **Decision state:** architectural direction agreed; behavioural defaults
  await product confirmation

## Abstract

Panda needs a durable mechanical scheduler for deterministic commands such as
periodically fetching gas-price data and synchronising it into a Metabase
database. The scheduler must survive container replacement, execute through the
session's normal execution environment, expose only explicitly named
credentials, remain inspectable by the owning session, and disappear with that
session.

The proposed product is a Postgres-backed, session-owned **scheduled command**
runtime exposed to agents as `panda cron`. It is deliberately separate from
`panda schedule`, which schedules a future model instruction. Mechanical jobs
do not invoke the model on successful runs; they wake the session only when
attention is useful. This plan records the design discussion, current Panda
constraints, proposed defaults, rejected directions and unresolved decisions.

## 1. Problem statement

An agent can currently create a schedule that wakes the model, but it lacks a
first-class way to say: "execute this deterministic command every six hours,
even when no model session is currently running".

Putting a crontab inside the runner container is not a product solution. A
container's writable layer can survive restarting that same container, but not
replacement, recreation or a clean redeployment. The crontab would also sit
outside Panda's session lifecycle, credential policy, command authority,
history and failure signalling. Baking jobs into the image would persist them,
but would turn agent-created automation into an infrastructure deployment.

Host cron has the opposite problem: it persists, but Panda cannot reliably
attribute, authorise, inspect, revoke or delete the work with its owning
session. The scheduler therefore belongs in Panda's durable product model.

## 2. Decision

Build a custom mechanical scheduler with these boundaries:

1. Postgres is the durable source of truth.
2. Every job belongs to exactly one session, never an agent family.
3. The agent-facing namespace is `panda cron`.
4. Internally the domain noun is **scheduled command**, not cron.
5. Commands execute through Panda's existing Bash/execution-environment seam.
6. The scheduler understands schedules and execution policy, not programming
   languages.
7. Stored credential names are explicit; credential values never enter the job
   definition.
8. Successful runs are mechanical and model-free. Failures may wake the owning
   session through a bounded policy.
9. Database definitions use defence-in-depth integrity protection.
10. Workspace source files are live by default; immutable artifacts may be an
    optional hardened mode later.

## 3. Product vocabulary

Panda's current vocabulary makes the ownership boundary non-negotiable: a
session is the durable runtime lane, while a thread is replaceable and may
change on `/reset` (Panda Agent, 2026a). A mechanical job therefore stores a
`session_id`, not a thread ID. Any failure wake resolves
`session.current_thread_id` at the last responsible moment.

The command names should communicate two different products:

| Surface | Meaning |
| --- | --- |
| `panda schedule` | Wake the session/model later with an instruction. |
| `panda cron` | Execute a deterministic command later without inference. |
| scheduled command | Internal domain and storage term for mechanical work. |
| scheduler worker | Runtime component that materialises, claims and settles runs. |

There is no literal command collision today. The existing command group is
`schedule`; `cron` is currently only an option describing a recurring model
schedule (Panda Agent, 2026d). `scheduler` should remain a component name rather
than an agent-facing noun.

## 4. Perspectives

| Perspective | What good looks like | Why container cron fails |
| --- | --- | --- |
| Agent | Discoverable commands, preflight, run history, useful failure context and no secret handling. | Hidden crontab state is difficult to inspect or debug. |
| Application maintainer | A script behaves the same manually and on schedule. | The container may lack the intended cwd, credentials or runtime after recreation. |
| Operator | Central inventory, disable/delete controls, bounded resource use and health metrics. | Jobs are scattered across containers and hosts. |
| Security reviewer | Session authority, live credential checks, tamper detection, redaction and audit. | Cron bypasses Panda's policy and lifecycle seams. |
| Runtime engineer | Postgres leases, idempotent occurrences, bounded workers and clean shutdown. | A second process supervisor and cron daemon create parallel runtime truth. |
| Product owner | Automation is a Panda capability that follows the session. | Infrastructure configuration is not an agent experience. |

## 5. Agent experience

### 5.1 Intended workflow

The comfortable path is:

1. Write the job in the session workspace.
2. Run it manually through Bash with the intended credentials.
3. Create the cron disabled.
4. Execute one managed `run-now` occurrence.
5. Inspect bounded output and status.
6. Enable the recurring job.
7. Receive a useful wake on failure and recovery, without success spam.

Illustrative CLI, not yet a final contract:

```bash
panda cron create "sync gas prices" \
  --cron "0 */6 * * *" \
  --timezone Europe/Bratislava \
  --command "pnpm exec tsx jobs/sync-gas-prices.ts" \
  --credentials GAS_API_TOKEN,DATABASE_URL \
  --disabled

panda cron run <cron-id>
panda cron runs <cron-id> --limit 20
panda cron enable <cron-id>
```

Use `--credentials`, not `--requires`, to match Panda's existing product
language. An omitted or empty value means no credential authority.

### 5.2 Proposed command family

- `cron create`
- `cron list`
- `cron show`
- `cron runs`
- `cron update`
- `cron enable`
- `cron disable`
- `cron delete`
- `cron run`

The command catalog remains the source of truth for descriptors, help, shim
routes and policy. Cron is a CLI Tool invoked through Bash, not a new direct
model Tool (Panda Agent, 2026a; Panda Agent, 2026b).

### 5.3 Debuggability

Every occurrence should expose:

- job ID, immutable version ID and occurrence ID;
- scheduled, claimed, started and finished timestamps;
- resolved execution environment and cwd;
- status, exit code, timeout and cancellation reason;
- credential **names**, never values;
- bounded and redacted stdout/stderr metadata;
- safe failure classification;
- retry, overlap and missed-run decisions.

`cron show` explains configuration. `cron runs` explains history. `cron run`
uses the same production path as scheduled execution; it must not be a special
unmanaged shell escape hatch.

## 6. Execution contract

### 6.1 Language neutrality

Do not restrict jobs to `.sh`. Unix file extensions carry no security meaning,
and a signed shell wrapper can immediately execute an unsigned TypeScript,
Python or binary payload.

The scheduler accepts any command executable in the selected environment:

```text
pnpm exec tsx jobs/sync.ts
python3 jobs/sync.py
./jobs/sync.sh
./bin/sync
```

Runtime availability belongs to the execution environment. The scheduler must
not install interpreters, infer dependencies or execute code inside Panda core.

### 6.2 Environment containment

The command runs only through the session's resolved execution environment and
inherits its real containment:

- filesystem mounts and cwd/root;
- network reachability;
- Bash/tool policy;
- credential policy;
- timeout and process controls;
- environment lifecycle.

This is not a stronger sandbox than the environment already provides. If that
environment can reach the internet, mounted host data, an API or a database,
the scheduled command can reach it too. Arbitrary Bash plus credentials is
powerful; scheduling adds persistence, not new execution authority.

The current persistent runner is physically agent-scoped, while execution
environment bindings and policies are session-scoped (Panda Agent, 2026e).
The final contract must specify how a session-owned job resolves that physical
runner without silently inheriting another session's authority.

### 6.3 Credential injection

The definition stores only requested names such as
`GAS_API_TOKEN,DATABASE_URL`. Before every occurrence Panda computes:

```text
requested credential names
    intersect
the session execution environment's live credential policy
    intersect
credentials still present for the owning agent
```

Panda authorises before decrypting and injects only that result into the child
process. Revocation therefore takes effect on the next run. Credential values
must not appear in definitions, signatures, prompts, logs, transcripts or
command output.

## 7. Security model

### 7.1 Threats considered

1. A database user modifies a scheduled-command definition outside Panda.
2. A process modifies workspace code used by a job.
3. An authorised or prompt-injected agent creates a malicious persistent job.
4. A job tries to access resources outside its intended execution environment.
5. Output or failure delivery leaks credentials.
6. Panda core, the host or the integrity key is compromised.

These threats are different. One magic signature does not solve all of them.

### 7.2 Authorisation and database roles

Primary prevention comes from authority, not cryptography:

- agent commands are session-scoped;
- management belongs to the `operate` tool group;
- create, update, enable and run-now additionally require live Bash authority;
- every requested credential must be allowed at creation and execution;
- the execution worker can claim and settle runs but should not rewrite job
  definitions;
- direct model reads use restricted session views rather than raw runtime
  tables.

Tool-group membership alone must not accidentally turn `operate` into delayed
arbitrary Bash. The command handler needs an explicit Bash-authority check for
the selected execution target.

### 7.3 Definition integrity

Encryption is not the primary control because definitions must not contain
secrets. Use HMAC-SHA-256 over a canonical immutable version containing at
least:

- job, version and session IDs;
- command and cwd;
- execution-target resolution policy;
- schedule and timezone;
- credential names;
- timeout, retry, overlap and missed-run policy;
- enabled/deployment-relevant state covered by the chosen version model.

Store `key_id` and `integrity_tag` with the version. Verify before every
execution. An invalid tag must fail closed, record `integrity_violation`, retain
safe evidence and wake the owning session/operator. Panda must never repair the
problem by signing the value currently found in Postgres.

For Panda Mini, the key belongs in a core-only host directory outside the
channel-shared `~/.panda` tree:

```text
~/.panda-core-secrets/scheduled-command-integrity.key
```

Mount it read-only into `panda-core` only, for example at
`/run/secrets/panda-core/scheduled-command-integrity.key`. Channel services
must explicitly clear both scheduler-key environment variables because they
share the stack env file. The runner and scheduled process never receive the
key. A deployment secret or cloud secret manager is the equivalent in other
environments. Use a dedicated key rather than `CREDENTIALS_MASTER_KEY`.

HMAC detects a database attacker who lacks the external key. It does not stop
an attacker controlling Panda core, the host/key, or the authorised update
path. Defending those cases requires approval policy, least privilege and
external audit; an external signing service is not justified for V1.

### 7.4 Workspace code integrity

Mandatory `.sh` signing is rejected. It creates friction while protecting only
a wrapper that may delegate to mutable child code and dependencies.

V1 should execute the live workspace by default. A later hardened mode may pin
an immutable directory manifest, workspace snapshot, Git commit or container
image. If added, updating the artifact creates and signs a new job version; it
must never silently re-sign changed files. Pinning one entry file should not be
presented as transitive-code security.

### 7.5 Prompt injection and persistence

HMAC proves that Panda accepted a definition; it does not prove the definition
is benevolent. An agent with immediate Bash and credential authority can
already perform the operation once. Cron lets it persist. Operators may later
choose a policy requiring approval for credentialed jobs, but the proposed V1
keeps autonomous creation behind explicit `operate` plus Bash and credential
authority.

## 8. Persistence model

Keep mechanical commands separate from model schedules even if they reuse
generic Postgres and lease helpers.

### 8.1 Proposed tables

`runtime.scheduled_commands`

- stable job ID and owning session ID;
- title, enabled/cancelled state and active version ID;
- next-fire and failure/wake state;
- creator provenance and timestamps.

`runtime.scheduled_command_versions`

- immutable version number;
- command, cwd and target-resolution policy;
- schedule/timezone and execution policies;
- credential names;
- integrity key ID and HMAC;
- creation provenance and timestamp.

`runtime.scheduled_command_runs`

- occurrence ID, job/version/session IDs and scheduled time;
- lease/claim fencing data;
- resolved environment ID;
- status, timestamps, exit metadata and safe error;
- bounded output reference/metadata;
- failure-wake state.

Expose scoped readonly `session.*` views. Definitions must not contain credential
values or inline script bodies.

### 8.2 Versioning and audit

Updates insert an immutable version and transactionally move the active pointer.
Every run records the exact version. Optimistic expected-version checks prevent
lost updates, while the external HMAC detects unauthorised database mutation.

An append-only audit records creator provenance, version changes, credential
names and hashes—not secrets or unbounded command output. A database superuser
can still delete database-local audit evidence; externally anchored forensic
logging is outside V1.

## 9. Runtime and lifecycle

The current model scheduler already demonstrates useful patterns: database
clock authority, bounded materialisation, one active occurrence per task,
leases with renewal, session ownership, durable occurrence IDs and current
thread resolution for model delivery (Panda Agent, 2026d). Reuse those patterns,
not the inference-specific schema or prompts.

Proposed flow:

1. List due definitions using the database clock and a bounded batch.
2. Materialise one durable occurrence with a stable occurrence ID.
3. Claim it through a lease and fencing token.
4. Reload the definition/version and verify its HMAC.
5. Reload the session and resolve its live execution environment and policies.
6. Resolve and authorise only named credentials.
7. Execute through the existing Bash seam with bounded runtime/output.
8. Renew the lease while work is active.
9. Settle success, failure, timeout, cancellation or skip exactly once for that
   claim.
10. Apply failure/recovery wake policy, resolving the current thread only then.

The delivery guarantee should be honestly at-least-once. An occurrence ID can
be exposed to the process for application-level idempotency. Panda must not
claim exactly-once effects against arbitrary external APIs and databases.

### 9.1 Session lifecycle

- `/reset` does not change job ownership or command execution.
- Failure delivery follows the session's new current thread.
- Archived sessions do not start new occurrences.
- Session deletion removes definitions, versions and outputs through cascading
  FKs; active remote work is aborted when claim renewal observes the deletion.
- A non-sensitive deletion audit may remain; no command text or output remains.
- Agent deletion follows existing session cleanup rather than inventing a
  parallel cron ownership rule.
- A missing/stopped execution environment blocks the run and produces a useful
  failure; it must not fall back to a broader environment silently.

The race between deletion and an already-running external process requires an
explicit cancellation path. Deleting the database row alone does not stop a
process that already holds credentials.

## 10. Failure and wake experience

The proposed default is:

1. Wake the owning session on the first failure.
2. Aggregate identical repeated failures without waking every occurrence.
3. Wake again when the job recovers.
4. Wake immediately for integrity violations or revoked authority.

A failure wake should contain only structured, bounded information:

- job/version/run IDs and title;
- scheduled time, duration and status;
- exit code or failure classification;
- safe truncated output reference/tail;
- consecutive-failure count;
- commands for inspect, run-now, disable or update.

It must not contain credential values or blindly inject attacker-modified
command text. Wake storms are product and cost bugs.

## 11. Operational requirements

- A bounded worker belongs in runtime assembly; domain policy stays under
  `src/domain` and shell execution stays under `src/integrations` (Panda Agent,
  2026b; Panda Agent, 2026c).
- Postgres leases support multiple Panda core replicas and crash recovery.
- New pools, listeners or lease clients require explicit capacity budgeting.
- Work remains wake/drain-driven; no permanently hot agent loop.
- Shutdown stops claims, cancels or hands off active executions, and settles
  owned claims honestly.
- Health and metrics cover due lag, claim age, runtime, failure rate, wake
  suppression and integrity violations.
- Output and run-history retention are bounded and operator-configurable.
- Conservative quotas cover jobs per session, minimum interval, concurrent
  executions, timeout and output size.

The simplest V1 placement is a worker inside Panda core. A standalone scheduler
service is justified only if measured isolation or scaling needs earn the extra
deployment unit.

## 12. Directional decisions awaiting confirmation

The discussion produced recommended answers, but the product owner has not yet
accepted them. The final vision must resolve these explicitly.

| Question | Recommended direction | Alternatives |
| --- | --- | --- |
| Feature scope | Recurring commands only. | Add one-off commands; build workflows. |
| Environment binding | Resolve the session's current environment each run. | Pin creation environment; dedicated environment per job. |
| Delivery guarantee | At-least-once with occurrence ID. | At-most-once; exactly-once claim. |
| Downtime/misfires | Coalesce missed occurrences into one immediate run. | Skip all; replay all. |
| Overlap | Keep at most one pending occurrence. | Skip; allow parallel runs. |
| Failure signalling | First failure, aggregated repeats, recovery wake. | Every failure; history only. |
| Wake destination | Owning session's current thread. | Operator only; originating channel. |
| Creation authority | `operate` + live Bash + requested credentials. | Human approval for credentialed jobs; operator-only. |
| Credential authority | Requested names intersected with live policy. | Creation snapshot; all current credentials. |
| Session deletion | Cancel and delete state/output; retain safe audit only. | Delete absolutely everything; disable/orphan. |
| Worker placement | Bounded worker in Panda core. | Separate Panda service; host cron. |
| Tamper defence | Roles + immutable versions + HMAC + audit. | External signer; database roles only. |

## 13. Alternatives rejected

### Container or host cron

Rejected because ownership, durability, policy, inspection and cleanup sit
outside Panda.

### Extend `panda schedule` with a command mode

Rejected because future model thought and deterministic execution have
different authority, cost, failure and observability semantics.

### A language-specific scheduler

Rejected because `.sh`, TypeScript and Python are properties of an execution
environment, not scheduling concepts.

### Encrypt job definitions

Rejected as the primary integrity mechanism. Definitions contain no secrets;
HMAC addresses undetected modification with less semantic confusion.

### Sign only the entry script

Rejected because it does not cover delegated code, imports, packages,
interpreters or downloaded payloads.

### Exactly-once external effects

Rejected because Panda cannot atomically commit with arbitrary APIs and
databases. Stable occurrence IDs and idempotent application code are honest.

## 14. Delivery phases

### Phase 0 — settle the contract

Approve or replace every answer in Section 12. Freeze the CLI vocabulary,
failure policy and environment-binding rule before schema work.

### Phase 1 — domain and persistence

- add scheduled-command definitions, immutable versions, runs and scoped views;
- implement schedule calculation, bounded materialisation and lease fencing;
- implement session cleanup and versioned integrity payloads;
- add migrations and integrity checks.

### Phase 2 — secure execution

- add the core-only integrity key configuration and rotation-ready `key_id`;
- verify HMAC before execution;
- resolve live environment, Bash authority and credential intersection;
- execute through the existing shell seam with cancellation and bounds;
- settle every claim on all terminal paths.

### Phase 3 — agent-facing operation

- register `cron.*` modules under `operate`;
- add CLI/shim help, JSON contracts and concise output;
- implement disabled-create, run-now, inspection and lifecycle commands;
- add a compact prompt discovery reference rather than bloating default context.

### Phase 4 — failure experience and operations

- add failure aggregation, recovery wakes and safe structured prompts;
- add metrics, health, quotas, retention and operator diagnostics;
- exercise restart, recreation, deletion, reset, revocation and multi-replica
  races;
- document the user and operator workflows.

Optional immutable artifacts and approval policy come after V1 evidence, not as
unfinished scaffolding.

## 15. Acceptance criteria

The feature is ready when:

- a session creates a disabled gas-price synchronisation job, runs it once,
  inspects it and enables it without handling raw secrets;
- the job survives Panda and runner container recreation because its definition
  and run state are durable;
- successful runs do not invoke the model;
- a failure wakes the current thread with bounded, redacted diagnostics;
- repeated failures do not create a wake storm and recovery is signalled;
- revoked Bash or credential authority prevents the next execution;
- database definition tampering fails closed before command execution;
- no scheduled process receives the integrity key or unrequested credentials;
- session deletion stops active work and removes its durable cron state;
- `/reset` does not orphan jobs and later wakes target the replacement thread;
- concurrent core replicas do not execute one occurrence without lease fencing;
- tests cover crash recovery, stale claims, output bounds, deletion races,
  credential redaction, integrity failure, missed runs and overlap policy.

## 16. Verification expectations

Implementation should run, at minimum:

```bash
pnpm typecheck
pnpm architecture:import-law:ratchet
pnpm agent-command-shim:check
pnpm ci:prompt-contracts
```

Add focused domain, Postgres, runner, command and lifecycle tests. Run `pnpm
smoke` against a disposable `TEST_DATABASE_URL` because this crosses runtime,
tool and persistence boundaries. Live verification must include core/runner
recreation, not merely process restart.

## References

Mojzis, P. and Codex (2026) *Mechanical scheduler design discussion*, 24–28
August. Unpublished internal product discussion.

Panda Agent (2026a) *Developer vocabulary*. Available at:
[`docs/developers/vocabulary.md`](../developers/vocabulary.md) (Accessed: 28
August 2026).

Panda Agent (2026b) *Panda architecture*. Available at:
[`docs/developers/architecture.md`](../developers/architecture.md) (Accessed: 28
August 2026).

Panda Agent (2026c) *ADR 0001: Runtime architecture guardrails*. Available at:
[`docs/developers/adr/0001-runtime-architecture-guardrails.md`](../developers/adr/0001-runtime-architecture-guardrails.md)
(Accessed: 28 August 2026).

Panda Agent (2026d) *Scheduled tasks source contract*. Available at:
[`src/domain/scheduling/tasks`](../../src/domain/scheduling/tasks) (Accessed: 28
August 2026).

Panda Agent (2026e) *Execution environments*. Available at:
[`docs/developers/execution-environments.md`](../developers/execution-environments.md)
(Accessed: 28 August 2026).
