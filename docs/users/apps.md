# Apps

Apps are filesystem-backed micro-apps for one agent.

Current MVP:

- app source of truth lives under `~/.panda/agents/<agentKey>/apps/<appSlug>/`
- app data lives in SQLite
- UI is optional and served locally by Panda
- this is localhost/dev shape, not production auth shape

## Folder Shape

```text
~/.panda/agents/<agentKey>/apps/<appSlug>/
  manifest.json
  views.json
  actions.json
  schema.sql
  public/
    index.html
    app.js
    app.css
  data/
    app.sqlite
```

Only `manifest.json` is required.

Typical defaults:

- `views.json`
- `actions.json`
- `README.md`
- `public/index.html`
- `data/app.sqlite`

Optional files like `schema.sql`, `README.md`, or seed notes are fine.
The runtime ignores them. Humans and agents do not.

## `manifest.json`

Minimal example:

```json
{
  "name": "Counter"
}
```

Supported keys:

- `name`: required display name
- `description`: optional short summary
- `identityScoped`: when `true`, views and actions require `identityId`
- `publicDir`: defaults to `public`
- `entryHtml`: defaults to `public/index.html`
- `viewsPath`: defaults to `views.json`
- `actionsPath`: defaults to `actions.json`
- `dbPath`: defaults to `data/app.sqlite`

## `views.json`

Views are readonly SQL queries the runtime exposes through `app_view` and the local HTTP API.

Example:

```json
{
  "summary": {
    "description": "Return the current counter value.",
    "sql": "select value as count from counter limit 1"
  },
  "recent_logs": {
    "description": "Return recent rows with simple offset pagination.",
    "sql": "select id, label from logs order by id desc",
    "pagination": {
      "mode": "offset",
      "defaultPageSize": 20,
      "maxPageSize": 100
    }
  }
}
```

## `actions.json`

Actions are fixed SQL mutations or SQL reads with optional wake behavior.

Example:

```json
{
  "increment": {
    "description": "Increment the counter by the provided amount.",
    "mode": "native",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["amount"],
      "properties": {
        "amount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        }
      }
    },
    "sql": "update counter set value = value + :amount"
  },
  "log_cycle_day": {
    "description": "Store a new cycle log and wake Panda after the write.",
    "mode": "native+wake",
    "inputSchema": {
      "type": "object",
      "required": ["flow"],
      "properties": {
        "flow": {
          "type": "string",
          "enum": ["spotting", "light", "medium", "heavy"]
        }
      }
    },
    "sql": "insert into cycle_logs (identity_id, flow, notes) values (:identityId, :flow, :notes)",
    "wakeMessage": "The user logged a new cycle entry for {{input.logged_on}} with flow {{input.flow}} and notes {{input.notes}}. Reflect only if something useful stands out."
  }
}
```

Supported keys:

- `description`: optional short summary
- `mode`: `native`, `wake`, or `native+wake`
- `sql`: one SQL string or an array of SQL strings run in one transaction
- `inputSchema`: optional structured input contract. This is the preferred lane now.
- `requiredInputKeys`: optional lightweight fallback for older or simpler apps
- `wakeMessage`: optional text used when the action wakes Panda. It can use simple placeholders like `{{input.flow}}`, `{{input.notes}}`, `{{app.name}}`, `{{action.name}}`, `{{result.changes}}`, or `{{result.lastInsertRowid}}`.

### `inputSchema`

Current MVP supports a small JSON-schema-ish subset:

- top level must be `{ "type": "object" }`
- `properties` can define `string`, `integer`, `number`, `boolean`, or `array`
- arrays can contain scalar item types
- supported constraints:
  - strings: `enum`, `minLength`, `maxLength`
  - numbers/integers: `enum`, `minimum`, `maximum`
  - arrays: `minItems`, `maxItems`
  - objects: `required`, `additionalProperties`

This is enough for forms, agent guidance, and catching dumb payloads without turning Panda into AJV fan fiction.

It is not full JSON Schema.
Not supported:

- union field types like `["string", "null"]`
- nested object fields inside `inputSchema.properties`

If a field is optional, leave it out of the payload instead of sending `null`.

### Wake Templates

`wakeMessage` is template-aware.

Supported placeholders:

- `{{app.name}}`
- `{{app.slug}}`
- `{{action.name}}`
- `{{identity.id}}`
- `{{input.some_key}}`
- `{{result.changes}}`
- `{{result.lastInsertRowid}}`

Arrays render as comma-separated values.
If a placeholder is missing, Panda just leaves it blank instead of throwing a tantrum.

## Runtime Params

Panda injects these named params into views and actions:

- `agentKey`
- `appSlug`
- `identityId`
- `sessionId`
- `now`

App-provided params must not override those names.

If `identityScoped` is `true`, `identityId` is required.

## UI

If `public/index.html` exists, Panda serves the app through the daemon automatically.
Default local URL:

```text
http://127.0.0.1:8092/apps/<agentKey>/<appSlug>/
```

The app SDK is available at `/panda-app-sdk.js`.

Current SDK surface:

- `window.panda.bootstrap()`
- `window.panda.view(name, { params, pageSize, offset })`
- `window.panda.action(name, input)`
- `window.panda.getContext()`
- `window.panda.setContext({ identityId, identityHandle, sessionId })`

Important:

- `window.panda` is the client
- `bootstrap()` returns bootstrap data, not a second SDK object
- `view()` returns `{ ok, appSlug, viewName, items, page? }`
- `action()` returns `{ ok, appSlug, actionName, changes, ... }`

Minimal example:

```js
const bootstrap = await window.panda.bootstrap();
const summary = await window.panda.view("summary");
console.log(bootstrap.context, summary.items);

await window.panda.action("log_entry", {
  flow: "medium",
  notes: "rough afternoon"
});
```

For browser URLs, prefer `identityHandle` in query params for human-facing links, for example:

```text
/apps/panda/period-tracker/?identityHandle=angelina
```

The app host resolves that handle to the real `identityId` before touching the database or wake pipeline.

### URL Hints

`app_create` and `app_list` now return UI URLs when `hasUi` is true:

- `appUrl`: best current URL for Panda to use
- `localAppUrl`: local default, usually `127.0.0.1`
- `internalAppUrl`: for internal container-to-container access, for example browser-runner -> panda-core
- `publicAppUrl`: optional public or tunneled base URL if you set `PANDA_APPS_BASE_URL`

For Docker/browser-runner setups, set:

- `PANDA_APPS_HOST=0.0.0.0`
- `PANDA_APPS_PORT=8092`
- `PANDA_APPS_INTERNAL_BASE_URL=http://panda-core:8092`
- `BROWSER_ALLOW_PRIVATE_HOSTS=panda-core`

## Agent Tools

Panda can inspect and use installed apps through:

- `app_create`
- `app_list`
- `app_check`
- `app_view`
- `app_action`

Use `app_create` to scaffold a blank app.
Use `app_list` first when you need to inspect an existing one.
Use `app_check` when Panda says an app is invalid or the UI/tool contract feels weird.
It returns action descriptions, `inputSchema`, and effective `requiredInputKeys`, which matters because otherwise the model will absolutely manage to do something dumb.

## Example Apps

In-repo examples live at:

- `examples/apps/counter`
- `examples/apps/period-tracker`

## Current Limits

- no migrations yet
- no custom server code inside app folders
- no arbitrary SQL from the browser
- no production auth story yet
- no cross-app access
