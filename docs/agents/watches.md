# Watches For Agents

This is the practical guide.

If a user asks Panda to set up a watch, the agent should build a deterministic watch config and reference stored credentials by key name.

Do not put raw secrets into `panda watch create` or `panda watch update` payloads.

## Schema Discovery

`panda watch create --help --json` and `panda watch update --help --json`
expose compact top-level command contracts plus the detailed watch schema catalog.

Normal flow:

1. decide the `source.kind`
2. decide the `detector.kind`
3. run `panda watch create --help --json` or `panda watch update --help --json` if you need exact branch fields, examples, or notes
4. for a simple HTTP JSON scalar threshold, use `--url <url> --value-path <path> --percent-change <n>` with `panda watch create` or `panda watch update`
5. otherwise, run `panda watch create` or `panda watch update` with the nested source/detector JSON

Do not guess branch fields when the exact shape matters.
Ask command help.

## The Rule

The pattern is always:

1. store or reuse a credential
2. reference the credential key in the watch config
3. create the watch

For example:

- store `DATABASE_URL`
- use `"credentialEnvKey": "DATABASE_URL"`
- never paste the actual connection string into the watch source config

## Credential Rules

- Prefer the CLI for human-entered secrets.
- Use `panda env set <key> --stdin` or `panda env set <key> --from-file <path>` only when the agent already has the secret value.
- Stored env credentials belong to the current agent.

Agent CLI example:

```bash
printf '%s' "$DATABASE_URL" | panda env set DATABASE_URL --stdin
```

Or via operator CLI:

```bash
panda credentials set DATABASE_URL --agent panda
```

## Source Credential Fields

- `mongodb_query`: `credentialEnvKey`
- `sql_query`: `credentialEnvKey`
- `http_json`: `auth.credentialEnvKey` or `headers[].credentialEnvKey`
- `http_html`: `auth.credentialEnvKey` or `headers[].credentialEnvKey`
- `imap_mailbox`: `usernameCredentialEnvKey` and `passwordCredentialEnvKey`

## MongoDB Example

Store credential:

```bash
printf '%s' "$MONGO_URI" | panda env set MONGO_URI --stdin
```

Create watch:

```json
{
  "title": "New Mongo registrations",
  "intervalMinutes": 1,
  "source": {
    "kind": "mongodb_query",
    "credentialEnvKey": "MONGO_URI",
    "database": "app",
    "collection": "registrations",
    "operation": "find",
    "filter": {},
    "sort": {
      "createdAt": -1
    },
    "limit": 100,
    "result": {
      "observation": "collection",
      "itemIdField": "_id",
      "itemCursorField": "createdAt",
      "summaryField": "email",
      "fields": ["email", "plan", "createdAt"]
    }
  },
  "detector": {
    "kind": "new_items",
    "maxItems": 20
  }
}
```

Agent command:

```bash
panda watch create --json @watch.json
```

## SQL Example

Store credential:

```bash
printf '%s' "$DATABASE_URL" | panda env set DATABASE_URL --stdin
```

Create watch:

```json
{
  "title": "New SQL charges",
  "intervalMinutes": 1,
  "source": {
    "kind": "sql_query",
    "credentialEnvKey": "DATABASE_URL",
    "dialect": "postgres",
    "query": "select id, created_at, customer_email, amount_cents from charges order by created_at desc limit 100",
    "result": {
      "observation": "collection",
      "itemIdField": "id",
      "itemCursorField": "created_at",
      "summaryField": "customer_email",
      "fields": ["customer_email", "amount_cents", "created_at"]
    }
  },
  "detector": {
    "kind": "new_items",
    "maxItems": 20
  }
}
```

Agent command:

```bash
panda watch create --json @watch.json
```

Notes:

- SQL watches are single-statement only.
- SQL watches are read-only and run inside a read-only transaction.
- If the user wants writes, that is not a watch. That is a bad idea wearing a fake moustache.

## HTTP JSON Example

Store credential:

```bash
printf '%s' "$COINAPI_TOKEN" | panda env set COINAPI_TOKEN --stdin
```

Create watch:

```json
{
  "title": "BTC moved 10 percent",
  "intervalMinutes": 5,
  "source": {
    "kind": "http_json",
    "url": "https://api.example.com/btc-price",
    "method": "GET",
    "auth": {
      "type": "bearer",
      "credentialEnvKey": "COINAPI_TOKEN"
    },
    "result": {
      "observation": "scalar",
      "valuePath": "price_usd",
      "label": "BTC/USD"
    }
  },
  "detector": {
    "kind": "percent_change",
    "percent": 10
  }
}
```

Agent command:

```bash
panda watch create --json @watch.json
```

If the API uses a custom header instead of bearer auth:

```json
{
  "title": "API with custom auth header",
  "intervalMinutes": 5,
  "source": {
    "kind": "http_json",
    "url": "https://api.example.com/items",
    "headers": [
      {
        "name": "x-api-key",
        "credentialEnvKey": "COINAPI_TOKEN"
      }
    ],
    "result": {
      "observation": "snapshot",
      "path": "data"
    }
  },
  "detector": {
    "kind": "snapshot_changed"
  }
}
```

## HTTP HTML Example

Store credential if needed:

```bash
printf '%s' "$LISTINGS_COOKIE" | panda env set LISTINGS_COOKIE --stdin
```

Create watch for new listings:

```json
{
  "title": "New property listings",
  "intervalMinutes": 10,
  "source": {
    "kind": "http_html",
    "url": "https://example.com/properties",
    "headers": [
      {
        "name": "cookie",
        "credentialEnvKey": "LISTINGS_COOKIE"
      }
    ],
    "result": {
      "observation": "collection",
      "itemSelector": ".listing-card",
      "itemId": {
        "selector": "a",
        "attribute": "href"
      },
      "itemCursor": {
        "selector": ".listing-date"
      },
      "summary": {
        "selector": ".listing-title"
      },
      "fields": {
        "price": {
          "selector": ".listing-price"
        },
        "location": {
          "selector": ".listing-location"
        }
      }
    }
  },
  "detector": {
    "kind": "new_items",
    "maxItems": 20
  }
}
```

Agent command:

```bash
panda watch create --json @watch.json
```

Create watch for a page-content change instead:

```json
{
  "title": "Docs page changed",
  "intervalMinutes": 15,
  "source": {
    "kind": "http_html",
    "url": "https://example.com/docs/page",
    "result": {
      "observation": "snapshot",
      "mode": "readable_text"
    }
  },
  "detector": {
    "kind": "snapshot_changed",
    "excerptChars": 600
  }
}
```

## IMAP Example

Store credentials:

```bash
printf '%s' "$IMAP_USERNAME" | panda env set IMAP_USERNAME --stdin
printf '%s' "$IMAP_PASSWORD" | panda env set IMAP_PASSWORD --stdin
```

Create watch:

```json
{
  "title": "New inbox mail",
  "intervalMinutes": 1,
  "source": {
    "kind": "imap_mailbox",
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "mailbox": "INBOX",
    "usernameCredentialEnvKey": "IMAP_USERNAME",
    "passwordCredentialEnvKey": "IMAP_PASSWORD"
  },
  "detector": {
    "kind": "new_items",
    "maxItems": 10
  }
}
```

Agent command:

```bash
panda watch create --json @watch.json
```

You can inline the username and keep only the password secret:

```json
{
  "title": "New inbox mail",
  "intervalMinutes": 1,
  "source": {
    "kind": "imap_mailbox",
    "host": "imap.example.com",
    "username": "alerts@example.com",
    "passwordCredentialEnvKey": "IMAP_PASSWORD"
  },
  "detector": {
    "kind": "new_items"
  }
}
```

## Update Example

Changing the interval:

```json
{
  "watchId": "93c34fb6-cf45-4fba-b243-0b116f7c9b3d",
  "intervalMinutes": 1
}
```

Agent command:

```bash
panda watch update 93c34fb6-cf45-4fba-b243-0b116f7c9b3d --every 1
```

Changing the source or detector resets watch state and reboots the watch from fresh state.
Panda should expect `panda watch create` and `panda watch update` to preflight the source immediately, so bad paths or broken probes fail at save time instead of on the first poll.

## Disable Example

```json
{
  "watchId": "93c34fb6-cf45-4fba-b243-0b116f7c9b3d"
}
```

Agent command:

```bash
panda watch disable 93c34fb6-cf45-4fba-b243-0b116f7c9b3d
```

## Agent Checklist

- Pick the simplest source adapter that fits.
- Use `new_items` for rows, messages, listings, or feed entries.
- Use `snapshot_changed` for page or document content changes.
- Use `percent_change` for numeric threshold watches.
- Do not use negative array indices like `[-1]` in watch paths. Sort/filter upstream and use `[0]`.
- Store secrets in credentials and reference them by key.
- Do not invent a custom probe in v1.
- For inspection, use `panda watch list`, `panda watch show`, and `panda watch runs`.
- Operators can still use Postgres views like `session.watches`, `session.watch_runs`, and `session.watch_events`.
