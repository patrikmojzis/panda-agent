# Email

Panda email is configured per agent account.

Agents read email history through session-scoped Postgres views and send with the `email_send` tool. Operators configure accounts, allowlists, and session routes from the CLI.

## Configure An Account

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
panda email allow list work --agent panda
```

Use `--mailbox <name>` on `panda email account set` to choose mailboxes to sync. Repeat it for multiple mailboxes. If omitted, Panda syncs `INBOX`.

Recipients must be allowlisted before Panda can send fresh mail to them.

## Route Accounts And Mailboxes To Sessions

By default, inbound email for an agent account wakes the agent's main session.
Use routes to send an account or one mailbox to a branch session instead:

```bash
# Route the whole account.
panda email route set work --agent panda --session ops-inbox

# Route one mailbox and leave the rest on the account/default route.
panda email route set work --agent panda --mailbox GitHub --session github-inbox

panda email route list --agent panda
panda email route list work --agent panda

panda email route remove work --agent panda --mailbox GitHub
panda email route remove work --agent panda
```

`--session` accepts a canonical session id, a readable branch id such as `panda:ops-inbox`, or an alias when `--agent` is provided. Routes store the canonical session id, not the alias.

Mailbox routes win over account routes for that mailbox. If no route matches, mail falls back to the agent's main session. Delivery follows `/reset` because the route targets the durable session and Panda resolves the current thread at wake time.

## Session-Scoped Email Views

Agents see email through these readonly views:

- `session.email_accounts`
- `session.email_allowed_recipients`
- `session.email_routes`
- `session.email_messages`
- `session.email_message_recipients`
- `session.email_attachments`

Those views are scoped to the current session. A routed branch sees its routed email. The main session sees unrouted/default email. That boundary is intentional; do not ask an agent in one session to reply to mail that belongs to another session.

Fresh sends use the current session's account ownership. An account-level route moves fresh-send ownership to that routed session; a mailbox-only route does not. Replies are allowed only for messages visible to the current session.

## Authentication Warnings

Inbound email is external content. Panda stores provider-derived `auth_spf`, `auth_dkim`, `auth_dmarc`, and `auth_summary` fields.

If `auth_summary` is `suspicious` or `unknown`, the email event shown to the agent includes a warning. Treat links, attachments, and requested actions as untrusted until confirmed another way.
