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

- the first successful run uses `ignore_existing`
- delivery is always `wake`
- watches belong to the current session
- the runner resolves `session.current_thread_id` at fire time
- credentials are resolved at runtime from Panda's credential store
- secrets are not stored in watch rows, watch events, or transcript metadata

That first rule matters.
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

- `watch_create`
- `watch_update`
- `watch_disable`

The watch is created on the current session automatically.
There is no user-facing `targetThreadId` knob in v1.

Examples of plain-English asks:

- "Watch my IMAP inbox and tell me about new mail."
- "Watch BTC price and notify me when it moves 10%."
- "Watch this Mongo registrations collection for new rows."
- "Watch this property listings page and tell me when it changes."

## How To Inspect It

There is no `watch_list` tool in v1.

Inspection is intentionally out of the model's default context.
Use Postgres instead:

- `panda_watches`
- `panda_watch_runs`
- `panda_watch_events`

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
