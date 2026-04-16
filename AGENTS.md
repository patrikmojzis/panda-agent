# Panda Agent Notes

## Working Style

- Keep Panda small, readable, and *modular*.
- Prefer simple abstractions over framework-heavy architecture.
- Keep model-facing prompt text in `src/prompts`, not buried in runtime code.
- When adding provider support, keep provider-specific request/response shaping out of the core thread loop.
- Avoid copying large chunks from other projects; use them for patterns and ideas, then adapt to Panda's smaller codebase.
- Always verify each change with a live Panda agent - e.g. have u added a new tool? have Panda test it out. get a live feedback from her.
- Use comment to write down nuance behind architecture decisions / deeper reasons why / or anything that might be unclear in the future. Use them when they matter.
- Think ahead - if you know something will be extended in future - keep it modular.
- Consider docs/developers/architecture.md to keep the code clean

## Philosophy

- Prefer negative code: the best code is often code removed. Favor simpler implementations, fewer files, fewer abstractions, and less moving parts when they solve the problem just as well. "The real hero of programming is the one who writes negative code."
- As much as UX is important so is AX (agent experience)

## Local Inspiration Repos

- The agent is free to inspect `/Users/patrikmojzis/Projects/openclaw` for inspiration around provider boundaries, replay/sanitization ideas, and transport adapters.
- The agent is free to inspect `/Users/patrikmojzis/Projects/claude-code` for inspiration around Anthropic client setup, streaming patterns, and Claude-oriented API usage.
- The agent is free to inspect `/Users/patrikmojzis/Projects/codex` for inspiration.
- `/Users/patrikmojzis/Projects/hermes-agent`
- These repos are reference material only. Panda should stay much lighter and easier to reason about than either of them.

## Provider Docs

- Anthropic docs: [https://platform.claude.com/docs](https://platform.claude.com/docs)
- OpenAI docs: [https://developers.openai.com/api/docs](https://developers.openai.com/api/docs)

## Current Direction

- If you see this line, don't concern your self with compatibility migration, the app has not yet been deployed. I will delete this line once you should start be concerned.
- `Thread` should orchestrate runs, tools, hooks, and pipelines.
- Providers should own API-specific payload construction and response normalization.
- A provider-neutral transcript model is likely coming later; for now, keep changes compatible with the current transcript shape unless explicitly requested otherwise.
- Prefer PostgreSQL as Panda's primary persistent storage direction.
- Design storage work with Docker deployment in mind and assume Panda should survive container restarts without data loss.
- Prefer modeling sessions, threads, messages, runs, and tool activity as relational records, with JSON used only where flexibility is helpful.
- identity = person, agent = persona, session = durable lane, thread = replaceable backing history, memory = agent-global or optional identity-scoped

## Panda Chat Vision

- The durable runtime anchor is the `session`, not the identity and not the raw thread.
- An `agent` is the primary persistent entity. It owns one `main` session by default and may also have `branch` sessions.
- A `thread` is the replaceable transcript/runtime backing for one session. Reset keeps the session and swaps the thread.
- `Thread` is still the inner agent loop. The outer wake-driven runtime lives on top of it and should stay separate from `agent-core`.
- User-facing chat should feel like one brain, many windows, optional branches: TUI and channels attach to the same agent session unless someone explicitly branches or rebinds.
- Panda chat is wake-driven, not a hot `while (true)` loop. New inputs, heartbeats, resumes, and manual pokes wake a thread and let it run until it becomes idle.
- All inbound events should become durable history with source metadata. The model should be able to see where messages came from, but connector-specific metadata exposed to the model should stay minimal.
- Panda uses one shared PostgreSQL database, many processes, and no fake in-memory persistence.
- `queue` and `wake` are distinct delivery modes. Queued inputs should persist and wait for the next active cycle or flush; wake inputs should make the thread runnable immediately.
- Heartbeats, watches, scheduled tasks, conversation bindings, and route memory should follow the session and resolve the current thread at execution time.
- The terminal UI is primarily a debug and introspection surface over persisted session/thread state. It should reflect cross-channel activity, support resuming sessions, and avoid inventing terminal-only conversation semantics when the transcript already contains the answer.

## What to avoid
- Needless complexity that can spread

## Optimal project structure
- `app`: entrypoints, process lifecycle, runtime assembly, CLI wiring
- `kernel`: the inner agent loop and provider-neutral execution primitives
- `prompts`: editable model-facing prompt text, wrappers, and default templates
- `personas`: persona packs like Panda tool policy, contexts, and subagent policy
- `domain`: business concepts like agents, identity, sessions, threads, scheduling, and channel records
- `integrations`: external systems like providers, Telegram, WhatsApp, Postgres, shell
- `ui`: terminal and other human-facing surfaces
- `lib`: small pure helpers
