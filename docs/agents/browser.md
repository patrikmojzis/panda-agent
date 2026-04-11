# Browser For Agents

Use the `browser` tool when `web_fetch` is not enough.

Examples:

- forms
- click-heavy sites
- pages that need real DOM state
- screenshots or PDFs

Do not use it just because it looks cool.

`web_fetch` is cheaper and simpler for plain reading.

## Basic Pattern

Use this loop:

1. `navigate`
2. read the returned snapshot
3. act using `ref` values like `e1`
4. rely on the returned post-action snapshot
5. `close` when done

Important:

- `navigate`, `click`, `type`, `press`, `select`, and `wait` already return a fresh snapshot
- do not waste calls by immediately asking for `snapshot` again unless you actually need another look

## Prefer Refs Over Selectors

Snapshots label interactive elements as `e1`, `e2`, and so on.

Prefer:

```json
{"action":"click","ref":"e3"}
```

Only fall back to CSS selectors when:

- the element is missing from the snapshot
- you need something more specific than the snapshot exposed

If a ref no longer exists, take a fresh snapshot. Do not blindly reuse stale refs.

## Action Notes

`navigate`

- use for the first page load or when changing pages

`snapshot`

- use when you need a fresh page read without acting

`click`

- use `ref` first

`type`

- use for inputs and textareas
- `submit: true` is the fast path when Enter should submit

`press`

- use for keyboard-only interactions
- if you target nothing, it presses on the page itself

`select`

- use for real `<select>` elements

`wait`

- use only when you truly need to wait for a selector, text, URL fragment, or load state
- do not spam it after actions that already settle and snapshot

`evaluate`

- use when the snapshot is not enough
- return JSON-friendly values
- include an explicit `return`

Example:

```json
{"action":"evaluate","script":"return { title: document.title, href: location.href };"}
```

`screenshot`

- use when the user wants visual proof
- `fullPage: true` only works for whole-page screenshots, not element shots

`pdf`

- use for printable/exportable page capture

`close`

- call it when the browsing task is finished
- especially do this after one-off browsing jobs

## Good Habits

- keep the browsing goal narrow
- narrate what you are doing
- prefer reading the snapshot over guessing
- close the browser when the task is done

## Avoid

- opening the browser for pages `web_fetch` could read directly
- guessing CSS selectors before looking at a snapshot
- asking for repeated snapshots after every state-changing action
- leaving the browser open after you are clearly finished
