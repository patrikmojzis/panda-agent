# Email

Panda email is a first-class channel:

- receive through the built-in IMAP sync runner
- send through `panda email send`
- read history from Postgres session views

Runtime config lives in `runtime.email_accounts`.
Secrets are credential env-key refs and resolve through the normal credential resolver.

The sync runner polls enabled account mailboxes read-only, stores messages in `runtime.email_messages`, and wakes the agent only for mail observed after initial backfill. Mail wakes target the routed durable session, or the agent's main session when no route matches, and re-resolves the current thread at wake time.
Inbound body text is wrapped with `=====EXTERNAL CONTENT=====` markers before persistence.
Message input normalization, including inbound trust markers, auth summary fallback, recipient normalization, attachment normalization, and thread-key derivation, lives in `src/domain/email/message-input.ts`; `PostgresEmailStore` should persist normalized email records, not own those policies inline.
V1 does not do live DNS verification or trusted-auth-server matching itself; it parses `Authentication-Results` verdicts into `auth_spf`, `auth_dkim`, and `auth_dmarc`, uses failures to set `auth_summary = 'suspicious'`, and otherwise leaves inbound `auth_summary = 'unknown'`.

Outbound mail goes through `runtime.outbound_deliveries` with `channel = "email"` and connector key `smtp`.
The email adapter verifies the configured from address, enforces recipient allowlists and attachment limits again before SMTP send, and records successful outbound mail into email history.
Queued email metadata uses the internal `email_send` payload kind and must pass the `EmailSendPayload` contract in `src/domain/email/send-payload.ts`; do not cast outbound metadata directly inside the adapter.

Configure:

```bash
panda credentials set WORK_IMAP_USERNAME --agent panda
panda credentials set WORK_IMAP_PASSWORD --agent panda --stdin
panda credentials set WORK_SMTP_USERNAME --agent panda
panda credentials set WORK_SMTP_PASSWORD --agent panda --stdin

panda email account set work \
  --agent panda \
  --from patrik@example.com \
  --imap-host imap.example.com \
  --imap-port 993 \
  --imap-secure \
  --imap-username-key WORK_IMAP_USERNAME \
  --imap-password-key WORK_IMAP_PASSWORD \
  --smtp-host smtp.example.com \
  --smtp-port 465 \
  --smtp-secure \
  --smtp-username-key WORK_SMTP_USERNAME \
  --smtp-password-key WORK_SMTP_PASSWORD

panda email allow add work alice@example.com --agent panda
```

Routes:

```bash
# Route a whole account to a session.
panda email route set work --agent panda --session ops-inbox

# Route one mailbox to a session.
panda email route set work --agent panda --mailbox GitHub --session github-inbox

panda email route list --agent panda
panda email route list work --agent panda

panda email route remove work --agent panda --mailbox GitHub
panda email route remove work --agent panda
```

## Routing And Visibility

Routes live in `runtime.email_routes` and bind `(agent_key, account_key, mailbox?)` to a canonical `session_id`.
The CLI accepts session ids and aliases, but aliases are resolved before persistence.

Resolution rules:

- mailbox-specific routes win for that mailbox
- account routes are the fallback for all mailboxes on that account
- no matching route falls back to the agent's main session
- routes target durable sessions, so `/reset` moves future email wakes to the new current thread automatically

Inbound messages store `session_id` and, when applicable, `route_id`.
Outbound email also records `session_id`.
Fresh sends are allowed from the main session when the account has no account route, or from the routed account session when it does. Mailbox-only routes do not move fresh-send ownership. Replies must reference a message visible to the current session.

Readonly email views are session-scoped:

- `session.email_accounts` and `session.email_allowed_recipients` expose accounts/allowlists visible to the current session; account-level routes hide that account from main unless main owns the route
- `session.email_routes` exposes only routes whose `session_id` is the current session
- `session.email_messages`, `session.email_message_recipients`, and `session.email_attachments` expose rows for the current session, plus legacy null-session rows only to main

That privacy invariant has two halves: delivery must wake the intended session, and readonly views must not leak another session's routed email.

Email event prompts include authentication fields and warning text whenever `auth_summary` is not `trusted`. `unknown` is not safe; treat it like suspicious for agent instructions, links, and attachments.

## Code Map

- [src/domain/email/cli.ts](../../src/domain/email/cli.ts) owns `panda email account`, `panda email allow`, and `panda email route`
- [src/domain/email/postgres.ts](../../src/domain/email/postgres.ts) owns route resolution, session ownership checks, and email persistence
- [src/integrations/channels/email/sync-runner.ts](../../src/integrations/channels/email/sync-runner.ts) resolves routes and wakes current session threads
- [src/domain/threads/runtime/postgres-readonly.ts](../../src/domain/threads/runtime/postgres-readonly.ts) owns `session.email_*` visibility
- [src/prompts/runtime/email-events.ts](../../src/prompts/runtime/email-events.ts) renders auth warning prompts
