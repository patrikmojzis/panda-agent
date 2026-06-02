# Tool Surface Decisions

## Principle

Fewer tools are usually easier for agents to choose from.

But fewer names can mean fatter schemas. A merged action-router tool can save
selection effort while making argument construction worse. Count both:

- selection cost: how many tool names the model must distinguish
- schema cost: visible `name` + `description` + JSON argument schema tokens
- shape cost: branch count, unrelated actions, and required-field ambiguity

Prefer merging tools when the resource is the same and the action branches stay
small. Prefer separate tools, or context-gated exposure, when a merge creates a
branchy junk drawer.

## Counting Method

Each tool is counted as `JSON.stringify(Tool.piTool)`, estimated with Panda's
current `ceil(chars / 4)` token estimator. This is a stable comparison number,
not provider billing truth.