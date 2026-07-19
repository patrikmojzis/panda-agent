# Web Fetch For Agents

Use `panda web fetch` for bounded public GETs that should become model-ready text or a managed artifact.

```bash
panda web fetch https://example.com/article
panda web read web_abc123 --cursor cur_abc123
```

`web.fetch` supports HTML, plain text, Markdown, JSON, XML, CSV, PDF, images, and bounded binary files. HTML becomes readable Markdown. Text-like resources return an explicitly marked untrusted chunk. PDFs and images become viewable artifacts; binary bytes never go to stdout.

`--chunk-chars` limits readable characters returned in one response. It does not raise the network byte limit. Continue a truncated readable resource with its opaque `resourceRef` and `nextCursor`; `web.read` uses the short-lived session-scoped copy and does not repeat the request.

Private targets and HTTP 401/403 are terminal. Do not alter the URL or open a browser to bypass them. Use the browser for client-rendered public pages. Use curl for custom methods, headers, authentication, local services, or protocol debugging.

Operators may set `WEB_FETCH_DOWNLOAD_LIMIT_BYTES`; the default is 10,000,000 bytes and the maximum is 104,857,600 bytes. The effective limit is returned in fetch successes and failures.
