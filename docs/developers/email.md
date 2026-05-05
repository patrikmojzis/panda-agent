# Email

Panda email is a first-class channel:

- receive through the built-in IMAP sync runner
- send through `email_send`
- read history from Postgres session views

Runtime config lives in `runtime.email_accounts`.
Secrets are credential env-key refs and resolve through the normal credential resolver.

The sync runner polls enabled accounts read-only, stores messages in `runtime.email_messages`, and wakes the agent only for mail observed after initial backfill.
Inbound body text is wrapped with `=====EXTERNAL CONTENT=====` markers before persistence.
V1 does not do live DNS verification or trusted-auth-server matching itself; it parses `Authentication-Results` verdicts into `auth_spf`, `auth_dkim`, and `auth_dmarc`, uses failures to set `auth_summary = 'suspicious'`, and otherwise leaves inbound `auth_summary = 'unknown'`.

Outbound mail goes through `runtime.outbound_deliveries` with `channel = "email"` and connector key `smtp`.
The email adapter verifies the configured from address, enforces recipient allowlists and attachment limits again before SMTP send, and records successful outbound mail into email history.

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
