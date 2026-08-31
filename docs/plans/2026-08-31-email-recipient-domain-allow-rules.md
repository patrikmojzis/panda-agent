# Email Recipient Domain Allow Rules

- **Date:** 31 August 2026
- **Status:** implemented and locally verified; deployment pending
- **Owner:** Panda email, database and Control
- **Decision state:** adopted target is exact-address and exact-domain allow
  rules; regex, generic wildcards, exclusions and implicit subdomain matching are
  out of scope
- **Citation style:** Harvard author-date

## Abstract

Panda currently authorises outbound email through exact recipient-address rows.
The Control UI rejects `*@company.com`, while the operator CLI accepts that
text as an address and persists it. Send-time policy still compares normalised
addresses by exact equality, so the row authorises only the literal address
`*@company.com`; it does not authorise other mailboxes at that domain (Panda
Agent, 2026d; Panda Agent, 2026e).

The proposed target is a small typed policy language with two rule kinds:
`address` and `domain`. A domain rule for `company.com` authorises every
recipient whose canonical domain is exactly `company.com`. It does not match a
subdomain or a longer lookalike suffix. The design deliberately rejects regex,
generic glob syntax and exclusions. This keeps policy review deterministic,
prevents ambiguous `*@domain` interpretation and preserves Panda's existing
default-deny and send-time revalidation behaviour.

Implementation requires a forward-only database migration, a typed domain/store
contract, explicit CLI and Control surfaces, session-view changes, documentation
and behaviour-level tests. Existing exact-address rows, IDs, account ownership
and creation timestamps will be preserved. No legacy value will be silently
reinterpreted as a domain rule.

## 1. Problem statement

An operator may reasonably want one email account to send to any current or
future mailbox at a trusted organisation. Adding every address individually is
safe but operationally expensive. Treating `*@company.com` as a pattern looks
convenient, but it is the wrong durable contract:

1. the UI and CLI currently disagree on whether the input is valid;
2. persistence and enforcement have no pattern semantics;
3. `*` is valid in the RFC 5322 `atext` grammar, so `*@example.com` can denote a
   literal mailbox rather than a wildcard (Resnick, 2008);
4. generic patterns are difficult to review and can match more authority than
   their author intended; and
5. regex would introduce anchoring, escaping and runtime-cost questions that do
   not belong in an email recipient allowlist.

This is an authorisation change, not a form-validation enhancement. The same
typed rule must be visible and enforced through the CLI, Control, Postgres,
session-scoped readonly access, queue admission and SMTP delivery.

## 2. Current state

### 2.1 Persistence and public model

`runtime.email_allowed_recipients` stores one `address` per agent and email
account. Its uniqueness boundary is `(agent_key, account_key, address)`, and
`session.email_allowed_recipients` exposes visible rows through the restricted
session role (Panda Agent, 2026f; Panda Agent, 2026g).

The domain record, store interface, Control DTO and Control UI row all expose an
`address` field. This shape cannot describe whether a value is an exact mailbox
or a domain policy without overloading string syntax.

### 2.2 Validation inconsistency

`normalizeEmailAddress` lowercases and accepts any non-space local part around a
single `@`-style boundary. It therefore accepts `*@company.com`. The Control
form uses Zod's narrower email validator and rejects the same value (Panda
Agent, 2026d; Panda Agent, 2026h).

Neither behaviour creates wildcard authority. The CLI's acceptance is merely a
misleading literal-address write.

### 2.3 Enforcement

`assertRecipientsAllowed` normalises all recipients, loads the account's rows
and requires exact `Set` membership. The send command checks before queueing,
and the outbound adapter checks again immediately before SMTP. Removal of a rule
after queueing therefore fails closed at delivery (Panda Agent, 2026e; Panda
Agent, 2026i; Panda Agent, 2026j).

This two-stage enforcement is correct and must remain the single policy seam.

## 3. Goal

The implementation is complete when operators can deliberately grant exact
domain authority without weakening existing exact-address policy.

| Capability | Target behaviour |
| --- | --- |
| Exact address | `alice@company.com` authorises only that canonical address. |
| Exact domain | `company.com` authorises any mailbox at exactly that domain. |
| Subdomain | `user@staff.company.com` remains blocked unless `staff.company.com` is explicitly allowed. |
| Lookalike suffix | `user@company.com.evil.example` remains blocked. |
| Wildcard-looking address | `*@company.com` is an address value, never an implicit domain rule. |
| Mixed recipients | One blocked recipient rejects the whole message before SMTP. |
| Revocation | A queued message is rechecked against current rules at delivery. |
| Visibility | Rules remain scoped to the same agent, account and routed session visibility as today. |
| Audit | Every add and removal identifies the rule ID, account, kind and canonical value. |

The operator experience should make the authority expansion obvious: allowing a
domain permits every current and future mailbox, alias and plus-address at that
exact domain.

## 4. Decision

### 4.1 Use typed rules

Represent the domain concept as a discriminated rule rather than a pattern:

```ts
type EmailRecipientAllowRuleKind = "address" | "domain";

interface EmailRecipientAllowRuleRecord {
  id: string;
  agentKey: string;
  accountKey: string;
  kind: EmailRecipientAllowRuleKind;
  value: string;
  createdAt: number;
}
```

The application contract should accept an object containing `kind` and `value`.
Do not add parallel `addAllowedAddress` and `addAllowedDomain` store methods;
one typed mutation seam is smaller and keeps normalisation local to the email
domain (Panda Agent, 2026b).

Suggested store operations are:

```ts
addRecipientAllowRule(input)
removeRecipientAllowRule(input)
listRecipientAllowRules(agentKey, accountKey)
assertRecipientsAllowed(agentKey, accountKey, addresses)
```

The existing assertion name remains useful because callers care about the
decision, not the storage representation.

### 4.2 Exact-domain semantics

A `domain` rule matches only canonical domain equality. It does not perform
suffix matching. Subdomains require their own domain rules.

Domain input must be a bare domain such as `company.com`. Reject:

- `*@company.com` and `@company.com`;
- schemes, paths, ports and query strings;
- leading or trailing dots, empty labels and invalid label characters;
- IP address literals; and
- generic wildcard characters.

Normalisation should trim surrounding whitespace, lowercase the domain and use
`domainToASCII` from `node:url` for a canonical ASCII/IDNA representation. That
function returns an empty string for an invalid domain and avoids adding a new
normalisation dependency (Node.js Contributors, n.d.). Apply explicit DNS-label
and length checks after conversion. Do not perform live DNS or MX lookups: DNS
availability is not stable configuration authority, and SMTP remains the
delivery-time network check.

Exact-address behaviour should retain the current compatibility contract. A
domain match extracts and canonicalises only the domain portion after address
normalisation. An address that is valid under Panda's existing exact-address
contract but not eligible for domain canonicalisation may still match an exact
address rule; it must not match a domain rule accidentally.

### 4.3 Default deny and all-recipient evaluation

Every envelope recipient represented by the send contract must match at least
one exact-address or exact-domain rule. Today that is every `to` and `cc`
recipient. Future `bcc` support must enter the same collection before policy
evaluation. Replies remain subject to the allowlist.

If any recipient is blocked, reject the whole send. Do not partially deliver an
email to the allowed subset.

### 4.4 Do not implement regex, globs or exclusions

Regex and generic globs are rejected because they create a programmable policy
language with little product value. They are harder to audit, easy to
mis-anchor, awkward to escape through shell and JSON surfaces, and capable of
pathological runtime behaviour.

Negative rules are also excluded from this change. A request for "this domain
except one person" should use exact-address allow rules instead of a domain
rule. If a proven future use case requires denial, design explicit typed deny
rules with a documented `deny`-over-`allow` precedence. Do not smuggle exclusion
syntax into `value`.

### 4.5 Delivery boundary

The rule authorises the recipient address handed to the SMTP adapter. Panda
cannot detect or control aliases and forwarding configured downstream at the
recipient's mail system. User and operator documentation must state this
boundary.

## 5. Target surfaces

### 5.1 Operator CLI

Keep the existing exact-address commands and add explicit domain commands:

```bash
panda email allow add work alice@company.com --agent panda
panda email allow add-domain work company.com --agent panda

panda email allow remove work alice@company.com --agent panda
panda email allow remove-domain work company.com --agent panda

panda email allow list work --agent panda
```

`allow list` should print a stable machine-readable representation under JSON
and a human table with `ID`, `KIND` and `VALUE`. Help must say that address rules
are literal and domain rules do not include subdomains. Do not advertise
`*@domain` as shorthand.

### 5.2 Control API

Keep `/agents/:agentKey/email/allowlist` as the resource collection, but change
its row contract to:

```json
{
  "id": "uuid",
  "agentKey": "panda",
  "accountKey": "work",
  "kind": "domain",
  "value": "company.com",
  "createdAt": "2026-08-31T00:00:00.000Z"
}
```

Create accepts `{accountKey, kind, value}`. Delete should target the immutable
rule ID rather than embedding an account key and address-like value into the
path. Continue requiring admin visibility, CSRF validation and operator audit.

No compatibility parser should infer `kind` from a value. This is an internal
Control hard cut delivered with the updated UI.

### 5.3 Control UI

Rename the row concept from "allowed recipient" to "recipient allow rule" and
show `Account`, `Type`, `Value` and `Created` columns. The add sheet should use a
required selector:

- **Exact address** — default; validates an email address.
- **Entire domain** — validates a bare domain and shows a warning that every
  current and future mailbox at that exact domain becomes eligible.

Confirmation and deletion copy must describe the selected rule kind. The UI
must not display a generic wildcard text box.

### 5.4 Session readonly surface

Replace `session.email_allowed_recipients` with
`session.email_recipient_allow_rules`. Expose `id`, `agent_key`, `account_key`,
`rule_kind`, `rule_value` and `created_at` under the existing session/account
visibility policy.

This is a deliberate naming hard cut: a domain is a rule, not a recipient.
Update agent, user, developer and Postgres documentation in the same change.

## 6. Database migration

### 6.1 Migration choice

Add the next append-only migration, currently expected to be
`0014_email_recipient_allow_rules`. Never edit the frozen pre-ledger baseline.
Panda deployment stops all database writers before applying migrations, and
older builds reject unknown ledger entries. A direct transactional hard cut is
therefore clearer than dual-write compatibility columns (Panda Agent, 2026c).

### 6.2 Migration steps

The migration should perform these operations on its supplied `PgQueryable` in
one transaction:

1. Assert that every existing row has a non-blank `address` and a valid parent
   email account. Fail with a specific diagnostic if safe conversion is not
   possible.
2. Drop `session.email_allowed_recipients` before changing its dependency.
3. Rename `runtime.email_allowed_recipients` to
   `runtime.email_recipient_allow_rules`.
4. Rename `address` to `rule_value`.
5. Add `rule_kind`, backfill every existing row to `address`, set it `NOT NULL`,
   add `CHECK (rule_kind IN ('address', 'domain'))`, and remove any temporary
   default so every future writer must choose explicitly.
6. Add a non-blank canonical-value check. Kind-specific normalisation remains
   in the application; do not encode email or IDNA parsing as a Postgres regex.
7. Replace the old unique index with uniqueness on
   `(agent_key, account_key, rule_kind, rule_value)` and rename remaining
   table-specific constraints/indexes to the new noun.
8. Preserve every existing row's `id`, `agent_key`, `account_key`, value and
   `created_at`. In particular, migrate `*@company.com` as
   `kind = 'address'`; never infer a domain rule from legacy text.
9. Create `session.email_recipient_allow_rules` with the same security-barrier
   route/account visibility predicate as the old view.
10. Let the migration runner reconcile readonly-role grants after the migration
    using the updated current-view catalog.

The migration should assert equal row counts before and after transformation in
its real-Postgres upgrade test. The transactional migration runner supplies the
actual rollback boundary.

### 6.3 Catalog and schema artefacts

Implementation must also:

- add `src/app/database/migrations/0014-email-recipient-allow-rules.ts`;
- add the immutable summary under
  `src/integrations/postgres/schema-versions/`;
- append the summary and executable source to the schema-version and migration
  catalogs;
- update the domain schema installer used by lightweight tests;
- update readonly view definitions and the current readonly-view catalog; and
- regenerate and review `src/app/database/schema-object-manifest.ts` from a
  freshly migrated disposable database.

### 6.4 Deployment and rollback

Before deployment, take a restorable database backup and confirm
`panda db status` has no unknown or changed migrations. Deploy through the
normal writer-stop sequence:

1. build the new application image;
2. stop every Panda database writer;
3. run `panda db migrate --writers-stopped`;
4. start the new application; and
5. run `panda db check` before enabling a production domain rule.

A migration failure rolls back the transaction and leaves writers stopped. If
the migration commits but application verification fails, fix forward with code
that understands the new ledger. Restoring the backup is an operator-controlled
full rollback performed only while writers remain stopped; an old build must
not be started against the newer database.

## 7. Implementation path

### Phase 1 — Domain contract and behaviour tests

1. Add the typed rule record and mutation input in
   `src/domain/email/types.ts`.
2. Add domain normalisation and address-domain extraction in
   `src/domain/email/shared.ts` or one focused local email module if the file
   would otherwise become shallow glue.
3. Write behaviour tables for canonical domains, IDNs, invalid values,
   subdomains and lookalike suffixes.
4. Change test fakes to model typed rules without duplicating production
   matching logic.

### Phase 2 — Migration and Postgres store

1. Add the production migration and schema-version entries described in
   Section 6.
2. Update `src/domain/email/postgres-shared.ts`,
   `src/domain/email/postgres-schema.ts` and `src/domain/email/postgres.ts` to
   use the new relation and typed rows.
3. Keep `assertRecipientsAllowed` as the sole decision seam and build separate
   address/domain sets per send. Do not compile or execute user patterns.
4. Update session readonly view definitions and schema integrity coverage.

### Phase 3 — Queue and delivery proof

1. Verify fresh sends and replies use the same assertion.
2. Preserve the admission check in `src/domain/email/commands.ts` and the
   delivery-time check in `src/integrations/channels/email/outbound.ts`.
3. Prove that removing a domain rule after queueing blocks SMTP delivery.
4. Prove that a mixed allowed/blocked recipient list sends nothing.

### Phase 4 — Operator and Control surfaces

1. Add explicit domain CLI commands and typed list output in
   `src/domain/email/cli.ts`.
2. Replace address-only Control DTOs and service methods in
   `src/domain/control/operator-service.ts`.
3. Update Control HTTP create/delete contracts in
   `src/integrations/control/http-server.ts`.
4. Update Control API types, form state, payloads, validation, table and
   confirmation copy under `apps/control-ui/src`.
5. Include rule ID, kind and canonical value in audit metadata.

### Phase 5 — Documentation and release verification

1. Update `docs/developers/email.md`, `docs/users/email.md`,
   `docs/agents/email.md` and `docs/users/postgres.md`.
2. Document exact-domain scope, no subdomains, no wildcard shorthand and the
   downstream forwarding boundary.
3. Regenerate the structural schema manifest and run the full verification
   matrix in Section 10.
4. Deploy first with existing exact-address rules only. Add a domain rule after
   schema and application health are confirmed.

## 8. Test strategy

Tests should protect observable behaviour through public seams rather than pin
private helper calls (Panda Agent, 2026b; Panda Agent, 2026a).

### 8.1 Normalisation cases

Cover at minimum:

- case and surrounding whitespace normalisation;
- IDN input and equivalent Punycode input converging on one value;
- invalid labels, empty labels, leading/trailing dots, ports, paths and IP
  literals;
- rejection of `*`, `@` and regex-like domain input; and
- exact-address compatibility remaining unchanged.

### 8.2 Policy cases

Cover at minimum:

- exact address allowed and neighbouring address denied;
- exact domain allowed regardless of mailbox local part;
- plus-address and alias-shaped local parts allowed by a domain rule;
- subdomain and lookalike suffix denied;
- `*@company.com` address rule not matching `alice@company.com`;
- all recipients required to match;
- replies evaluated identically to fresh sends; and
- rule revocation between queue and delivery failing closed.

### 8.3 Database and migration cases

Use real PostgreSQL to prove:

- fresh install produces the target schema;
- upgrade from the checked-in pre-0014 fixture preserves IDs, row count,
  ownership and timestamps;
- wildcard-looking legacy rows remain address rules;
- duplicate `(agent, account, kind, value)` rules are rejected;
- invalid rule kinds and blank values are rejected;
- session-view visibility remains route/account scoped;
- readonly grants include the new view and exclude the removed one;
- a failed migration rolls back fully; and
- a second migration run is a no-op.

### 8.4 Surface cases

Prove CLI, Control HTTP and Control UI agree on the same two rule kinds. Control
tests should cover CSRF, visibility, validation, audit metadata and deletion by
rule ID. The UI typecheck/build must cover the discriminated form payload and
type-specific confirmation copy.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Domain authority is broader than intended. | Explicit rule type, warning copy, confirmation and audit metadata. |
| Suffix comparison permits a lookalike domain. | Canonical exact equality only; no `endsWith` matching. |
| IDN spellings create duplicate policy. | Canonical ASCII storage through `domainToASCII` plus unique index. |
| Legacy `*@domain` is silently upgraded to broad authority. | Backfill every legacy row as `address`; never infer kind from text. |
| A rule is revoked after a message queues. | Preserve delivery-time policy revalidation. |
| Partial delivery leaks to an allowed subset. | Reject the complete send when any recipient is blocked. |
| Subdomain expectations are unclear. | Exact-domain wording and explicit tests; add each subdomain separately. |
| Downstream aliases or forwarding widen the real audience. | Document that Panda controls the submitted recipient address, not remote mail routing. |
| An old application starts after migration. | Schema-ledger verifier rejects unknown migrations; deploy new code and schema together. |
| API/store complexity grows into a generic policy framework. | Keep two kinds and one matching seam; no regex, glob or deny abstraction. |

## 10. Verification matrix

Run focused tests first, followed by the repository gates appropriate to this
cross-layer change:

```bash
pnpm exec vitest run \
  tests/email-postgres.test.ts \
  tests/email-outbound.test.ts \
  tests/email-send-command.test.ts \
  tests/email-postgres-schema.test.ts \
  tests/postgres-readonly-schema.test.ts \
  tests/control-auth-http.test.ts

pnpm typecheck
pnpm architecture:import-law:ratchet
pnpm agent-command-shim:check
pnpm control:typecheck
pnpm control:build
pnpm ci:postgres-schema-manifest:update
pnpm ci:postgres-startup
git diff --check
```

Review the generated schema-manifest diff rather than accepting it blindly.
Run `pnpm smoke` against a disposable `TEST_DATABASE_URL` because the change
crosses command, persistence and outbound delivery boundaries. Inspect the
smoke summary before raw logs on failure.

## 11. Production rollout

After deployment and `panda db check`:

1. confirm existing exact-address rules still list and send correctly;
2. add `company.com` as a domain rule to the intended email account;
3. send one canary to an approved `@company.com` mailbox;
4. attempt a bounded negative canary to a lookalike or unlisted test address
   and confirm rejection occurs before SMTP;
5. verify operator audit contains the domain rule ID, kind and value;
6. retain existing exact-address rows during observation; and
7. remove redundant exact rows only after domain behaviour and rollback posture
   are accepted.

Exact rows and a matching domain rule may coexist safely. Cleanup is optional
and should not be coupled to the migration.

## 12. Non-goals

- Regex or arbitrary glob matching.
- `*.company.com` subdomain trees.
- Negative/exclusion rules.
- A general-purpose authorisation policy engine.
- Comprehensive replacement of Panda's existing email-address parser.
- Live DNS, MX ownership or organisational identity verification.
- Detection of downstream aliases, distribution lists or forwarding.
- Partial delivery to the allowed subset of recipients.

## 13. Definition of done

The change is done when:

1. `address` and `domain` are the only persisted rule kinds;
2. existing exact-address rows survive migration without reinterpretation;
3. every surface uses typed kind/value contracts;
4. domain comparison is canonical exact equality;
5. subdomains, lookalikes and wildcard strings do not gain implicit authority;
6. admission and delivery-time checks share the same current-rule decision;
7. Control warnings and audit make domain breadth visible;
8. session readonly visibility is preserved under the renamed rule view;
9. real-Postgres upgrade and rollback tests pass;
10. schema manifest, typecheck, Control build, focused tests and smoke pass; and
11. documentation states the policy and downstream forwarding boundary.

## 14. Implementation record

Implementation completed the typed `address`/`domain` contract, canonical
domain matching, atomic rule removal, explicit CLI commands, Control API and UI
hard cut, migration `0014_email_recipient_allow_rules`, current readonly-view
catalog, schema manifest and public documentation. The migration rehearsal
proved that a legacy `*@company.com` row retains its ID, ownership, timestamp
and literal value as an `address` rule; it is never promoted to domain
authority.

The complete repository suite (2,677 tests) passed alongside the root and
Control typechecks, Control production build, import-law ratchet, command-shim
check, pinned migration checksums and fresh/legacy PostgreSQL startup
rehearsals. End-to-end model smoke remains a deployment gate because the
verification host did not provide model-provider credentials; this does not
weaken the database, policy or delivery-seam coverage recorded above.

## References

Mojzis, P. and Codex (2026) *Email recipient allowlist capability and domain-rule
design discussion*, 30–31 August. Unpublished internal product discussion.

Node.js Contributors (n.d.) *URL: `url.domainToASCII(domain)`*. Available at:
<https://nodejs.org/api/url.html#urldomaintoasciidomain> (Accessed: 31 August
2026).

Panda Agent (2026a) *ADR 0001: Runtime architecture guardrails*. Available at:
[`docs/developers/adr/0001-runtime-architecture-guardrails.md`](../developers/adr/0001-runtime-architecture-guardrails.md)
(Accessed: 31 August 2026).

Panda Agent (2026b) *Panda architecture*. Available at:
[`docs/developers/architecture.md`](../developers/architecture.md) (Accessed: 31
August 2026).

Panda Agent (2026c) *Database migrations*. Available at:
[`docs/developers/database-migrations.md`](../developers/database-migrations.md)
(Accessed: 31 August 2026).

Panda Agent (2026d) *Email address normalisation*. Available at:
[`src/domain/email/shared.ts`](../../src/domain/email/shared.ts) (Accessed: 31
August 2026).

Panda Agent (2026e) *Email Postgres store*. Available at:
[`src/domain/email/postgres.ts`](../../src/domain/email/postgres.ts) (Accessed:
31 August 2026).

Panda Agent (2026f) *Email Postgres schema*. Available at:
[`src/domain/email/postgres-schema.ts`](../../src/domain/email/postgres-schema.ts)
(Accessed: 31 August 2026).

Panda Agent (2026g) *Session readonly views*. Available at:
[`src/domain/threads/runtime/postgres-readonly.ts`](../../src/domain/threads/runtime/postgres-readonly.ts)
(Accessed: 31 August 2026).

Panda Agent (2026h) *Control email allowlist form*. Available at:
[`apps/control-ui/src/features/control/agent/connector-form-sheets.tsx`](../../apps/control-ui/src/features/control/agent/connector-form-sheets.tsx)
(Accessed: 31 August 2026).

Panda Agent (2026i) *Email send command*. Available at:
[`src/domain/email/commands.ts`](../../src/domain/email/commands.ts) (Accessed:
31 August 2026).

Panda Agent (2026j) *Email outbound adapter*. Available at:
[`src/integrations/channels/email/outbound.ts`](../../src/integrations/channels/email/outbound.ts)
(Accessed: 31 August 2026).

Resnick, P. (2008) *Internet Message Format*. RFC 5322. Available at:
<https://www.rfc-editor.org/rfc/rfc5322> (Accessed: 31 August 2026).
