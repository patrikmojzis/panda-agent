# Panda Chat Vision

## One Brain, Many Windows, Optional Branches

Panda should feel like one stable relationship with one brain.

That brain has a `home` thread.
The user can reach that same home through many windows:

- TUI
- Telegram
- WhatsApp
- future scheduled triggers like reminders or heartbeats

Those windows are different entry and delivery surfaces.
They are not separate brains by default.

## Core Model

The stable user-facing unit is:

- `(identity, agentKey) -> homeThreadId`

That means:

- one identity can have multiple Pandas
- each Panda can have its own home thread
- the same Panda can be reached from multiple channels

Threads are still the real persisted execution unit.
The difference is that one of them is the canonical `home`.

## Mental Model

### Home

`home` is the main thread for a Panda relationship.

This is the default place where:

- TUI opens
- new direct-message channel conversations land
- heartbeats run
- reminders run unless they explicitly target another thread

If the user thinks "this is my Panda chat", they mean `home`.

### Windows

Windows are surfaces that attach to the same relationship.

Examples:

- the TUI
- a Telegram DM
- a WhatsApp DM

By default, they all point at `home`.

That means a user should be able to talk to the same Panda from TUI and Telegram without feeling like they entered a different app or lost their context.

### Branches

Branches are explicit side threads.

They are useful when the user wants to peel off into a temporary topic, experiment, or deep-dive without dragging the whole home thread with them.

Branches are optional.
They are not the default story.

## Command Semantics

### TUI

TUI can expose real thread operations because it can actually show them.

- `/new` creates a fresh thread and opens it in TUI
- `/reset` creates a fresh empty thread and makes it the new `home`
- future branch-oriented commands can live here naturally

### External Channels

External channels should not pretend users can see hidden backend thread switches.

That means:

- do not use `/new` in Telegram, WhatsApp, or similar channel UIs
- use `/reset` instead
- `/reset` creates a fresh empty thread and makes it the new `home`

This is more honest.
`/new` sounds like "start over", but in a channel it really means "reroute this surface to another invisible thread", which is confusing bullshit.

## Delivery vs Execution

There are two separate questions:

- what thread should wake up?
- where should the reply go?

These are related, but they are not the same thing.

### Execution Target

The execution target is the thread Panda runs on.

Usually that is:

- `home`
- or an explicit branch thread

### Delivery Target

The delivery target is the route Panda uses when it sends a message out.

Examples:

- Telegram DM
- WhatsApp chat
- another future channel surface

Scheduled work should remember enough route information to reply naturally later, without forcing the model to rediscover where the user came from.

## Scheduled Work

Heartbeats, reminders, and other scheduled triggers belong to the Panda relationship, not to a random window.

Default rule:

- wake `home`
- deliver to the best remembered route for that relationship

If a reminder was explicitly created in a branch or bound to a specific route, it can override that default.

The important point is that scheduled work should feel like it came from the same Panda the user already knows.

## What To Avoid

- treating every channel as a separate default brain
- making Telegram or WhatsApp own the truth
- exposing hidden backend thread routing as a normal user concept
- making `/new` silently rewrite channel routing in places where the user cannot inspect thread state
