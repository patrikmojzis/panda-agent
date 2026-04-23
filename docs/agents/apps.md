# Apps

Use this when you need to create or edit a filesystem-backed micro-app for the current agent.

Current lane:

- `app_create` makes a blank scaffold
- the app lives under `~/.panda/agents/<agentKey>/apps/<appSlug>/`
- app data lives in SQLite
- UI is just static files in `public/`
- Panda owns the runtime API and wake path

Do not invent a template system in your head. We do not have one yet.

## Use The Right Flow

1. Call `app_create` to scaffold a blank app.
2. Read the generated `README.md` inside that app folder.
3. Edit `schema.sql`, `views.json`, `actions.json`, and `public/`.
4. Use `app_list` to confirm Panda sees the app.
5. If Panda seems confused, use `app_check` for exact file/path/message diagnostics.
6. Use `app_view` and `app_action` to test the contract.
7. If the app has a UI, use the URL from `app_create` or `app_list` and open it in a browser.

## Folder Shape

```text
~/.panda/agents/<agentKey>/apps/<appSlug>/
  manifest.json
  views.json
  actions.json
  schema.sql
  README.md
  public/
    index.html
    app.js
    app.css
  data/
    app.sqlite
```

`README.md` is for you.
The runtime ignores it. That is fine. Humans and agents do not.

## Create A Blank App

Use `app_create` with:

- `slug`
- `name`
- optional `description`
- optional `identityScoped`
- optional `schemaSql`

If `schemaSql` is provided, Panda writes it to `schema.sql` and applies it to `data/app.sqlite` immediately.
If not, Panda creates an empty database and a placeholder `schema.sql`.

## Files That Matter

- `manifest.json`: app metadata. Keep it small.
- `views.json`: readonly SQL for `app_view` and the app host.
- `actions.json`: fixed writes or reads for `app_action` and the app host.
- `schema.sql`: bootstrap SQL. Panda does not auto-run it later.
- `public/`: the human UI. You have freedom here.

## Action Rules

Prefer `inputSchema`.
It keeps the tool calls and browser payloads from going off the rails.

This is a small JSON-schema-ish subset, not full JSON Schema.
Supported field types are only:

- `string`
- `integer`
- `number`
- `boolean`
- `array`

Arrays can only contain scalar item types.
Do not use unions like `["string", "null"]`.
If a field is optional, omit it from the payload instead of sending `null`.

Use:

- `native` for pure SQLite work
- `wake` for pure follow-up without a DB write
- `native+wake` when the app writes data and Panda should react

If you use `wakeMessage`, keep it short and useful.
Use placeholders like:

- `{{app.name}}`
- `{{action.name}}`
- `{{input.foo}}`
- `{{result.changes}}`

Do not dump raw JSON into the wake unless you enjoy making the model read garbage.

## Identity Rules

If the app is identity-scoped:

- views and actions require `identityId`
- browser links should usually use `?identityHandle=<handle>`
- the app host resolves the handle to the real identity id server-side

Do not hardcode fake human handles as if they were identity ids.

## UI Rules

You can edit:

- `public/index.html`
- `public/app.js`
- `public/app.css`

The Panda SDK is available at `/panda-app-sdk.js`.
The daemon serves apps automatically.

Current surface:

- `window.panda.bootstrap()`
- `window.panda.view(name, { params, pageSize, offset })`
- `window.panda.action(name, input)`
- `window.panda.getContext()`
- `window.panda.setContext({ identityId, identityHandle, sessionId })`

Important:

- `window.panda` is the SDK client
- `await window.panda.bootstrap()` returns bootstrap data, not a second SDK object
- `await window.panda.view(...)` returns `{ ok, appSlug, viewName, items, page? }`
- `await window.panda.action(...)` returns `{ ok, appSlug, actionName, changes, ... }`

Minimal working pattern:

```js
const bootstrap = await window.panda.bootstrap();
const {context} = bootstrap;
const summary = await window.panda.view("summary");
console.log(summary.items);

await window.panda.action("log_entry", {
  flow: "medium",
  notes: "rough afternoon",
});
```

Do not make the app mutate data on page load. That is cursed.
Writes should happen on explicit click or submit.

## Testing

Basic contract test:

1. `app_create`
2. `app_list`
3. `app_check`
4. `app_view`
5. `app_action`

UI test:

```text
http://127.0.0.1:8092/apps/<agentKey>/<appSlug>/
```

For identity-scoped apps:

```text
http://127.0.0.1:8092/apps/<agentKey>/<appSlug>/?identityHandle=smoke
```

If `app_list` returns `internalAppUrl`, prefer that for browser-runner or browser subagent testing inside Docker.
If `app_list` returns `brokenApps`, Panda could not load those apps cleanly yet.

## Current Limits

- no migrations system yet
- no custom app-local backend code
- no production auth story yet
- no scaffolding templates beyond blank
