# Apps

Use this when you need to create or edit a filesystem-backed micro-app for the current agent.

Current lane:

- `app_create` makes a blank scaffold
- `app_link_create` makes a short-lived browser launch link for the current input identity
- the app lives under `~/.panda/agents/<agentKey>/apps/<appSlug>/`
- app data lives in SQLite
- UI is just static files in `public/`
- Panda owns the runtime API and wake path
- the app is another surface into the same Panda, not a separate backend brain

Do not invent a template system in your head. We do not have one yet.
If you need a concrete reference, inspect `/app/examples/apps` in Docker or `examples/apps` in a source checkout.

## Use The Right Flow

1. Call `app_create` to scaffold a blank app.
2. Read the generated `README.md` inside that app folder.
3. Edit `schema.sql`, `views.json`, `actions.json`, and `public/`.
4. Use `app_list` to confirm Panda sees the app.
5. If Panda seems confused, use `app_check` for exact file/path/message diagnostics.
6. Use `app_view` and `app_action` to test the contract.
7. If the app has a UI and a human wants to open it, use `app_link_create`.

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

## Filesystem And SQL Safety

Keep app files boring:

- `public/` assets must be real files inside the app directory
- do not use symlinks or hardlinks for served UI assets
- `data/app.sqlite` must be a real app-local SQLite file, not a symlink
- `views.json`, `actions.json`, and `schema.sql` must not use `ATTACH`, `DETACH`, `VACUUM INTO`, or `load_extension()`

Views are opened against SQLite in readonly mode.
Even if a view tries `insert ... returning`, Panda rejects it before data changes.

Actions can write to the app database, but they cannot mount another SQLite database, export the DB to an arbitrary path, or load native SQLite extensions.
If you need shared data later, model it intentionally instead of using SQLite file escape hatches.

## Action Rules

Prefer `inputSchema`.
It keeps the tool calls and browser payloads from going off the rails.
Prefer `inputSchema.required` over `requiredInputKeys`.
`requiredInputKeys` still exists as a lightweight fallback, but it is not the main lane anymore.

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

Default to `native+wake` for user-facing writes.
That is the normal app shape now.
If a human logs something in the UI, Panda should usually get the same event and be able to notice, react, remember, correlate, or follow up.
Think of the app as "chat with Panda, but through UI" rather than a detached CRUD toy.

Use plain `native` only when the action is intentionally inert and no follow-up matters.
Examples:

- harmless counters
- internal utility actions
- silent cache or maintenance writes

If you use `wakeMessage`, keep it short and useful.
Use placeholders like:

- `{{app.name}}`
- `{{action.name}}`
- `{{input.foo}}`
- `{{result.changes}}`

Do not dump raw JSON into the wake unless you enjoy making the model read garbage.
Good wake messages are short, templated, and restraint-oriented.
Tell Panda what happened and only invite follow-up when it might actually help.

## Identity Rules

`identityScoped` controls data partitioning, not audience control.

Use `identityScoped: true` when the app's rows are private per person.
Good fits:

- period tracker
- calorie tracker
- injections tracker
- private sleep or health logs
- anything where one identity should not see another identity's rows

Do not use identity scoping when the app is meant to show shared agent-wide data.
Good fits:

- company dashboards
- sales reports
- shared CRM views
- internal team tools
- any app where multiple identities should see the same rows

If two or more identities should see the same dashboard, leave `identityScoped` off.
Right now Panda can do:

- personal data per identity
- shared data for everyone who can open the app

Right now Panda cannot cleanly do:

- shared data, but only for a selected subset of identities

That is an access-control problem for later, not a reason to misuse identity scoping now.

If the app is identity-scoped:

- views and actions require `identityId`
- local/dev browser links can use `?identityHandle=<handle>`
- public app links should use `app_link_create`; the signed app session carries the identity
- app tools cannot choose another identity; they always use the human currently talking

Do not hardcode fake human handles as if they were identity ids.
If the app is not identity-scoped, do not force `identityHandle` into the URL just because it exists.

## UI Rules

You can edit:

- `public/index.html`
- `public/app.js`
- `public/app.css`

The Panda SDK is available at `/panda-app-sdk.js`.
The daemon serves apps automatically.
Keep JavaScript in `public/app.js`, not inline `<script>` tags. Public app auth uses a strict CSP and inline scripts are blocked.
Use the SDK for API calls. In public auth mode, the SDK adds the app-scoped CSRF header that Panda requires for `bootstrap`, `view`, and `action`.
Do not install or serve app UI code you do not trust yet.
The current path-based URL model is secure for Panda-built first-party apps, but it is not a hostile third-party JavaScript sandbox. Use separate origins later if apps become an app-store thing.

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

For a user-facing write, prefer an action shaped like:

```json
{
  "log_entry": {
    "mode": "native+wake",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["flow"],
      "properties": {
        "flow": {
          "type": "string",
          "enum": ["light", "medium", "heavy"]
        },
        "notes": {
          "type": "string"
        }
      }
    },
    "sql": "insert into cycle_logs (identity_id, flow, notes) values (:identityId, :flow, :notes)",
    "wakeMessage": "The user logged a cycle entry with flow {{input.flow}} and notes {{input.notes}}. Reflect only if something useful stands out."
  }
}
```

Do not make the app mutate data on page load. That is cursed.
Writes should happen on explicit click or submit.

## Opening Apps

For humans, prefer:

1. `app_link_create`
2. give the returned `openUrl`
3. the browser shows a tiny Continue page
4. the Continue submit signs the browser in and redirects to the clean app URL

The launch URL is one-time and short-lived.
It signs that browser into one app as the current input identity.
When public app auth is required, direct app URLs without that cookie return `401`.

Do not paste raw `identityId` or `identityHandle` into public URLs.
Those query params are a local/dev convenience, not the secure lane.

## Testing

Basic contract test:

1. `app_create`
2. `app_list`
3. `app_check`
4. `app_view`
5. `app_action`

UI test:

```text
http://127.0.0.1:8092/<agentKey>/apps/<appSlug>/
```

For local/dev identity-scoped apps:

```text
http://127.0.0.1:8092/<agentKey>/apps/<appSlug>/?identityHandle=smoke
```

If you need `internalAppUrl`, use `app_list({"appSlug": "...", "detail": "full"})` and prefer that URL for browser-runner or browser subagent testing inside Docker.
If `app_list` returns `brokenApps`, Panda could not load those apps cleanly yet. The default output is compact; use `detail: "full"` for exact diagnostics on one broken app.

## Current Limits

- no migrations system yet
- no custom app-local backend code
- no group/role authorization yet
- no scaffolding templates beyond blank
