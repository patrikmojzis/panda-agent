# Panda Agent Notes

## Working Style

- Keep Panda small, readable, and modular.
- Prefer simple abstractions over framework-heavy architecture.
- When adding provider support, keep provider-specific request/response shaping out of the core thread loop.
- Avoid copying large chunks from other projects; use them for patterns and ideas, then adapt to Panda's smaller codebase.

## Local Inspiration Repos

- The agent is free to inspect `/Users/patrikmojzis/Projects/openclaw` for inspiration around provider boundaries, replay/sanitization ideas, and transport adapters.
- The agent is free to inspect `/Users/patrikmojzis/Projects/claude-code` for inspiration around Anthropic client setup, streaming patterns, and Claude-oriented API usage.
- These repos are reference material only. Panda should stay much lighter and easier to reason about than either of them.

## Provider Docs

- Anthropic docs: [https://platform.claude.com/docs](https://platform.claude.com/docs)
- OpenAI docs: [https://developers.openai.com/api/docs](https://developers.openai.com/api/docs)

## Current Direction

- `Thread` should orchestrate runs, tools, hooks, and pipelines.
- Providers should own API-specific payload construction and response normalization.
- A provider-neutral transcript model is likely coming later; for now, keep changes compatible with the current transcript shape unless explicitly requested otherwise.
- Prefer PostgreSQL as Panda's primary persistent storage direction.
- Design storage work with Docker deployment in mind and assume Panda should survive container restarts without data loss.
- Prefer modeling threads, messages, runs, and tool activity as relational records, with JSON used only where flexibility is helpful.
