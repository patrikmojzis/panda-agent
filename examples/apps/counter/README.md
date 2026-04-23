## Counter Demo

This is the smallest useful micro-app example.

It demonstrates:

- static UI served by Panda
- `bootstrap()` before API calls
- one readonly view
- two silent `native` actions
- no mutation on page load

Bootstrap the SQLite file:

```sh
mkdir -p ~/.panda/agents/panda/apps/counter/data
sqlite3 ~/.panda/agents/panda/apps/counter/data/app.sqlite < ~/.panda/agents/panda/apps/counter/schema.sql
```
