# Apps

Apps are filesystem-backed micro-apps for one agent.

Current MVP:

- app source of truth lives under `~/.panda/agents/<agentKey>/apps/<appSlug>/`
- app data lives in SQLite
- UI is optional and served locally by Panda
- public access uses short-lived app links plus app-scoped cookies
- the app is another front door into the same agent, not a separate product brain

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
- `identityScoped`: when `true`, views and actions require `identityId` and data is partitioned per identity
- `publicDir`: defaults to `public`
- `entryHtml`: defaults to `public/index.html`
- `viewsPath`: defaults to `views.json`
- `actionsPath`: defaults to `actions.json`
- `dbPath`: defaults to `data/app.sqlite`

### When To Use `identityScoped`

Use `identityScoped: true` for personal or private apps where each identity should only see their own rows.
Examples:

- period tracker
- calorie tracker
- injections tracker
- private health or sleep logs

Do not use `identityScoped` for shared dashboards or shared internal tools.
Examples:

- company report dashboards
- sales dashboards
- shared CRM views
- internal team utilities

Important:

- `identityScoped` is about data partitioning
- it is not access control

So if multiple identities should see the same dashboard, leave `identityScoped` off.

Current runtime can do:

- personal data per identity
- shared data for everyone who can open the app

Current runtime cannot yet cleanly do:

- shared data, but only for a selected subset of identities

That is a separate access-control feature for later.

## `views.json`

Views are readonly SQL queries the runtime exposes through `app_view` and the local HTTP API.
Panda opens the app database in SQLite readonly mode for views, so row-returning writes like `insert ... returning` are rejected.

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
      "additionalProperties": false,
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

For user-facing writes, prefer `native+wake`.
That keeps the app aligned with Panda’s real model: the UI is another way to talk to the same agent.
If a person logs something in the app, Panda should usually see that write too so it can react, remember, and follow up when useful.

Use plain `native` when the action should be intentionally silent.
Use `wake` when you want follow-up without a DB write.

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
Prefer `inputSchema.required` over `requiredInputKeys` when you have a real schema.
`requiredInputKeys` is now the lightweight fallback, not the preferred mental model.

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
Good wake messages are short and restrained.
Tell Panda what happened and only invite follow-up when it might actually help.

## Runtime Params

Panda injects these named params into views and actions:

- `agentKey`
- `appSlug`
- `identityId`
- `sessionId`
- `now`

App-provided params must not override those names.

If `identityScoped` is `true`, `identityId` is required.
If it is `false`, apps can work without any identity context at all.

## Filesystem And SQL Boundaries

Each app is intentionally boring on disk:

- static UI serving only follows real files inside `public/`
- symlinked or hardlinked UI assets are rejected
- `data/app.sqlite` must stay inside the app directory and must not be a symlink
- app SQL cannot use `ATTACH`, `DETACH`, `VACUUM INTO`, or `load_extension()`

Those rules protect the "one app, one SQLite DB" contract.
If you need data shared between apps, build that as an explicit feature instead of smuggling another database file into SQLite.

## UI

If `public/index.html` exists, Panda serves the app through the daemon automatically.
Default local URL:

```text
http://127.0.0.1:8092/<agentKey>/apps/<appSlug>/
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

The important mental model:

- `view()` is "show me state"
- `action()` is "do the thing"
- `native+wake` actions are the closest thing to "the user told Panda something through the UI"

Keep JavaScript in `public/app.js`.
The default public CSP blocks inline `<script>` tags and third-party script URLs.

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
/panda/apps/period-tracker/?identityHandle=angelina
```

The app host resolves that handle to the real `identityId` before touching the database or wake pipeline.
For non-identity-scoped apps, do not bother passing `identityHandle` unless the UI specifically wants viewer context for something cosmetic.

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

### Public App Links

Do not publish `8092` directly.
Put Caddy or another reverse proxy in front of Panda and keep `panda-core:8092` on the Docker network.

Set:

- `PANDA_APPS_BASE_URL=https://your-domain.example`
- `PANDA_APPS_PUBLIC_HOST=your-domain.example`
- `PANDA_APPS_AUTH=required`
- optional `PANDA_APPS_RATE_LIMIT_PER_MINUTE=300`
- optional `PANDA_APPS_SESSION_TTL_HOURS=24`
- optional `PANDA_APPS_COOKIE_SECURE=false` only for local HTTP debugging

When `PANDA_APPS_BASE_URL` is set, Panda requires app auth by default unless you explicitly set `PANDA_APPS_AUTH=off`.
`PANDA_APPS_BASE_URL` should be a plain origin, like `https://your-domain.example`, with no path, query, fragment, username, or password.
For non-local hosts, `PANDA_APPS_BASE_URL` must use `https://`.
For non-local hosts, Panda refuses `PANDA_APPS_COOKIE_SECURE=false`.
The public Caddy compose also forces `PANDA_APPS_AUTH=required` and refuses to start without `PANDA_APPS_BASE_URL` and `PANDA_APPS_PUBLIC_HOST`.
When using `scripts/docker-stack.sh`, `PANDA_APPS_PUBLIC_HOST` must match the hostname in `PANDA_APPS_BASE_URL`.

The secure open flow is:

1. The agent calls `app_link_create`.
2. Panda returns a one-time `openUrl` for the current input identity.
3. The browser opens `/apps/open?token=...` and sees a tiny Continue page.
4. The Continue submit consumes the token, sets app-scoped cookies, and redirects to `/<agent>/apps/<app>/`.
5. Static files, views, and actions use the app session cookie.
6. API calls also require the SDK's app-scoped CSRF header.

The session cookie is `HttpOnly`.
The CSRF cookie is readable by app JavaScript so `/panda-app-sdk.js` can echo it in `x-panda-app-csrf`.

Recommended edge shape:

```text
Internet -> Caddy :443 -> panda-core:8092 on Docker network -> Panda app auth -> app files/API
```

Example files:

- `examples/Caddyfile.apps`
- `examples/docker-compose.apps-edge.yml`

With `scripts/docker-stack.sh`, the Caddy edge is auto-enabled when `PANDA_APPS_BASE_URL` is set.
So deployment stays the normal command:

```sh
./scripts/docker-stack.sh up --build
```

Caddy joins a small `apps_edge_net` shared only with `panda-core`.
Caddy also runs with a read-only root filesystem, no-new-privileges, and only `NET_BIND_SERVICE`.
Do not add a host port publish for `8092`.

Security notes:

- launch links are one-time and short-lived
- link previews cannot consume launch tokens because only POST redeems them
- app sessions are scoped to one `agentKey + appSlug + identityId`
- app API calls require an app-scoped CSRF token, so one app UI cannot use another app's session
- app rate limiting keys on the direct TCP peer; keep `8092` private so the only public peer is Caddy
- `app_link_create`, `app_view`, and `app_action` use the current input identity only
- views are enforced readonly at SQLite level
- app SQL cannot attach, detach, export other database files, or load native SQLite extensions
- static app serving rejects symlink and hardlink escapes
- identity scoping is still data partitioning, not authorization
- group/role authorization is not implemented yet
- the default CSP blocks third-party scripts and network calls from app UIs
- path-based app URLs are not a hostile third-party JavaScript sandbox; do not install untrusted app UI code as if it were isolated

## Agent Tools

Panda can inspect and use installed apps through:

- `app_create`
- `app_list`
- `app_link_create`
- `app_check`
- `app_view`
- `app_action`

Use `app_create` to scaffold a blank app.
Use `app_list` first when you need to inspect an existing one.
Use `app_link_create` when a human asks to open an app UI.
Use `app_check` when Panda says an app is invalid or the UI/tool contract feels weird.
It returns action descriptions, `inputSchema`, and effective `requiredInputKeys`, which matters because otherwise the model will absolutely manage to do something dumb.

## Example Apps

In-repo examples live at:

- `examples/apps/counter`
- `examples/apps/period-tracker`
- `examples/apps/context-capsule`
- `examples/apps/ops-radar`

## Current Limits

- no migrations yet
- no custom server code inside app folders
- no arbitrary SQL from the browser
- no group/role app authorization yet
- no cross-app access
