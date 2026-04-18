# Watches

Watches are Panda's polling system.

They are not vibes.
They are not "ask the model every five minutes."
They are deterministic code probes that wake Panda only after a real change has been detected.

## What V1 Supports

Sources:

- `mongodb_query`
- `sql_query`
- `http_json`
- `http_html`
- `imap_mailbox`

Detectors:

- `new_items`
- `snapshot_changed`
- `percent_change`

## Default Behavior

V1 behaves like this:

- `watch_create` and `watch_update` run a real preflight probe before saving
- negative array indices like `data[-1].score` are rejected; sort/filter upstream and use `[0]`
- enabled creates and enabled source/detector resets bootstrap state immediately on save
- the first successful runner poll still uses `ignore_existing` when a watch has no seeded state yet
- delivery is always `wake`
- watches belong to the current session
- the runner resolves `session.current_thread_id` at fire time
- credentials are resolved at runtime from Panda's credential store
- secrets are not stored in watch rows, watch events, or transcript metadata

That bootstrap rule matters.
If you create an inbox watch, Panda does not scream about the last 400 emails already sitting there.

## Good Use Cases

Watches are a good fit for:

- new emails in an IMAP mailbox
- new Mongo rows like registrations or chats
- new SQL rows like charges or support tickets
- BTC or other numeric thresholds from JSON APIs
- page content changes on blogs, listings, or docs
- new items in HTML or JSON feeds

## What V1 Is Not

V1 does not do:

- cron-style schedules
- webhooks
- push ingestion
- custom Python or Node probes
- browser-backed scraping
- Stripe-specific or YouTube-specific adapters
- digest batching
- a `watch_list` tool inside model context

If you need those, you're ahead of the product. Congratulations.

## How To Use It

Today the normal path is: tell Panda what you want to watch, and Panda should use:

- `watch_schema_get` when it needs the exact branch fields for a chosen source or detector kind
- `watch_create`
- `watch_update`
- `watch_disable`

The watch is created on the current session automatically.
There is no user-facing `targetThreadId` knob in v1.

In practice the flow is:

1. choose `source.kind` and `detector.kind`
2. call `watch_schema_get` if Panda needs the exact branch fields
3. call `watch_create` or `watch_update` with the real nested config

Examples of plain-English asks:

- "Watch my IMAP inbox and tell me about new mail."
- "Watch BTC price and notify me when it moves 10%."
- "Watch this Mongo registrations collection for new rows."
- "Watch this property listings page and tell me when it changes."

## How To Inspect It

There is no `watch_list` tool in v1.

Inspection is intentionally out of the model's default context.
Use Postgres instead:

- `session.watches`
- `session.watch_runs`
- `session.watch_events`

That keeps watch config visible to operators without stuffing admin state into every normal conversation.

## Practical Notes

- resetting a session does not kill its watches; they follow the session onto the new thread
- `sql_query` is single-statement only, requires an explicit dialect, and runs inside a read-only transaction
- `mongodb_query` supports JSON-configured `find` and `aggregate`
- `http_json` and `http_html` use the same safe fetch path and SSRF protections as Panda's web fetch stack
- `imap_mailbox` runs read-only and tracks mailbox identity with `uidValidity`

## Recommended Mental Model

Think of a watch as:

1. poll source
2. normalize observation
3. compare against stored state
4. persist event if changed
5. wake Panda with a machine-generated watch event

The model is step 5.
Everything before that is code.
