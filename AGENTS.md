# Panda Agent Notes

## Working Style

- Keep Panda small, readable, and modular.
- Prefer simple abstractions over framework-heavy architecture.
- When adding provider support, keep provider-specific request/response shaping out of the core thread loop.
- Avoid copying large chunks from other projects; use them for patterns and ideas, then adapt to Panda's smaller codebase.
- Always verify each change with a live Panda agent test by sending `ping` and confirming the response is `pong` before considering the work complete.

## Philosophy

- Prefer negative code: the best code is often code removed. Favor simpler implementations, fewer files, fewer abstractions, and less moving parts when they solve the problem just as well. "The real hero of programming is the one who writes negative code."

## Local Inspiration Repos

- The agent is free to inspect `/Users/patrikmojzis/Projects/openclaw` for inspiration around provider boundaries, replay/sanitization ideas, and transport adapters.
- The agent is free to inspect `/Users/patrikmojzis/Projects/claude-code` for inspiration around Anthropic client setup, streaming patterns, and Claude-oriented API usage.
- These repos are reference material only. Panda should stay much lighter and easier to reason about than either of them.

## Provider Docs

- Anthropic docs: [https://platform.claude.com/docs](https://platform.claude.com/docs)
- OpenAI docs: [https://developers.openai.com/api/docs](https://developers.openai.com/api/docs)

## Current Direction

- If you see this line, dont concern your self with compatibility migration, the app has not yet been deployed. I will delete this line once you should start be concerned.
- `Thread` should orchestrate runs, tools, hooks, and pipelines.
- Providers should own API-specific payload construction and response normalization.
- A provider-neutral transcript model is likely coming later; for now, keep changes compatible with the current transcript shape unless explicitly requested otherwise.
- Prefer PostgreSQL as Panda's primary persistent storage direction.
- Design storage work with Docker deployment in mind and assume Panda should survive container restarts without data loss.
- Prefer modeling threads, messages, runs, and tool activity as relational records, with JSON used only where flexibility is helpful.

## Panda Chat Vision

- The persistent unit is the `thread`, not the agent. A thread may switch agents between runs, but only one runtime may actively execute a thread at a time.
- `Thread` is the inner agent loop. The outer wake-driven runtime lives on top of it and should stay separate from `agent-core`.
- Panda chat is wake-driven, not a hot `while (true)` loop. New inputs, heartbeats, resumes, and manual pokes wake a thread and let it run until it becomes idle.
- All inbound events should become durable history with source metadata. The model should be able to see where messages came from, but connector-specific metadata exposed to the model should stay minimal.
- PostgreSQL is the source of truth for persisted chat state: threads, transcript messages, pending inputs, and runs. In-memory state should be treated as a cache or local convenience only.
- `queue` and `wake` are distinct delivery modes. Queued inputs should persist and wait for the next active cycle or flush; wake inputs should make the thread runnable immediately.
- The terminal UI is primarily a debug and introspection surface over persisted thread state. It should reflect cross-channel activity, support resuming threads, and avoid inventing terminal-only conversation semantics when the transcript already contains the answer.
