import os from "node:os";
import path from "node:path";
import {access, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";

import {afterEach, describe, expect, it} from "vitest";

import {AgentAppService} from "../src/integrations/apps/sqlite-service.js";
import {createAgentAppFixture, type AgentAppFixture} from "./helpers/app-fixture.js";

describe("agent app service", () => {
  const fixtures: AgentAppFixture[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await Promise.all(tempDirs.splice(0).map((target) => rm(target, {recursive: true, force: true})));
  });

  it("discovers filesystem apps and runs paginated views plus actions", async () => {
    const fixture = await createAgentAppFixture({
      views: {
        summary: {
          sql: "select value as count from counter limit 1",
        },
        recent_logs: {
          sql: "select id, label from logs order by id asc",
          pagination: {
            mode: "offset",
            defaultPageSize: 2,
            maxPageSize: 5,
          },
        },
      },
      actions: {
        increment: {
          mode: "native",
          sql: "update counter set value = value + coalesce(:amount, 1)",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["amount"],
            properties: {
              amount: {
                type: "integer",
                minimum: 1,
                maximum: 10,
              },
            },
          },
        },
      },
      seedSql: [
        "create table counter (value integer not null)",
        "insert into counter (value) values (1)",
        "create table logs (id integer primary key autoincrement, label text not null)",
        "insert into logs (label) values ('one'), ('two'), ('three')",
      ],
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    const apps = await service.listApps(fixture.agentKey);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.slug).toBe(fixture.appSlug);
    expect(apps[0]?.hasUi).toBe(true);

    const firstPage = await service.executeView(fixture.agentKey, fixture.appSlug, "recent_logs");
    expect(firstPage.items).toEqual([
      {id: 1, label: "one"},
      {id: 2, label: "two"},
    ]);
    expect(firstPage.page).toEqual({
      mode: "offset",
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });

    const secondPage = await service.executeView(fixture.agentKey, fixture.appSlug, "recent_logs", {
      offset: firstPage.page?.nextOffset,
    });
    expect(secondPage.items).toEqual([
      {id: 3, label: "three"},
    ]);
    expect(secondPage.page).toEqual({
      mode: "offset",
      limit: 2,
      offset: 2,
      hasMore: false,
    });

    await expect(
      service.executeAction(fixture.agentKey, fixture.appSlug, "increment"),
    ).rejects.toThrow("requires input keys: amount");

    await expect(
      service.executeAction(fixture.agentKey, fixture.appSlug, "increment", {
        input: {amount: 1.5},
      }),
    ).rejects.toThrow("input.amount must be an integer");

    await expect(
      service.executeAction(fixture.agentKey, fixture.appSlug, "increment", {
        input: {amount: 2, note: "nope"},
      }),
    ).rejects.toThrow("does not allow input.note");

    const action = await service.executeAction(fixture.agentKey, fixture.appSlug, "increment", {
      input: {amount: 4},
    });
    expect(action.mode).toBe("native");
    expect(action.changes).toBe(1);
    expect(action.wakeRequested).toBe(false);

    const summary = await service.executeView(fixture.agentKey, fixture.appSlug, "summary");
    expect(summary.items).toEqual([{count: 5}]);
  });

  it("requires identity for identity-scoped apps", async () => {
    const fixture = await createAgentAppFixture({
      identityScoped: true,
      views: {
        entries: {
          sql: "select flow from cycle_logs where identity_id = :identityId order by id asc",
        },
      },
      seedSql: [
        "create table cycle_logs (id integer primary key autoincrement, identity_id text not null, flow text not null)",
        "insert into cycle_logs (identity_id, flow) values ('angelina', 'light')",
      ],
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    await expect(
      service.executeView(fixture.agentKey, fixture.appSlug, "entries"),
    ).rejects.toThrow("requires identityId");

    const result = await service.executeView(fixture.agentKey, fixture.appSlug, "entries", {
      identityId: "angelina",
    });
    expect(result.items).toEqual([{flow: "light"}]);
  });

  it("refuses to open app databases through symlinks that escape the app", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);

    const outsideDbPath = path.join(fixture.dataDir, "outside.sqlite");
    const outsideDb = new DatabaseSync(outsideDbPath);
    try {
      outsideDb.exec("create table counter (value integer not null); insert into counter (value) values (999);");
    } finally {
      outsideDb.close();
    }

    await rm(fixture.dbPath, {force: true});
    await symlink(outsideDbPath, fixture.dbPath);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    await expect(
      service.executeView(fixture.agentKey, fixture.appSlug, "summary"),
    ).rejects.toThrow("must not be a symlink");
  });

  it("runs app views against SQLite in readonly mode", async () => {
    const fixture = await createAgentAppFixture({
      views: {
        sneaky_write: {
          sql: "insert into counter (value) values (999) returning value as count",
        },
        summary: {
          sql: "select value as count from counter order by value desc limit 1",
        },
      },
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    await expect(
      service.executeView(fixture.agentKey, fixture.appSlug, "sneaky_write"),
    ).rejects.toThrow(/readonly|read-only|attempt to write/i);

    const summary = await service.executeView(fixture.agentKey, fixture.appSlug, "summary");
    expect(summary.items).toEqual([{count: 1}]);
  });

  it("blocks app SQL from attaching or exporting other database files", async () => {
    const fixture = await createAgentAppFixture({
      actions: {
        attach_other_db: {
          mode: "native",
          sql: "attach database '/tmp/other.sqlite' as other",
        },
        export_db: {
          mode: "native",
          sql: "vacuum into '/tmp/app-copy.sqlite'",
        },
        load_native_extension: {
          mode: "native",
          sql: "select load_extension('/tmp/nope')",
        },
      },
      views: {
        harmless_label: {
          sql: "select 'attach database is blocked as SQL, not as text' as note",
        },
      },
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    await expect(
      service.executeAction(fixture.agentKey, fixture.appSlug, "attach_other_db"),
    ).rejects.toThrow("App SQL must not use ATTACH");
    await expect(
      service.executeAction(fixture.agentKey, fixture.appSlug, "export_db"),
    ).rejects.toThrow("App SQL must not use ATTACH");
    await expect(
      service.executeAction(fixture.agentKey, fixture.appSlug, "load_native_extension"),
    ).rejects.toThrow("App SQL must not use ATTACH");
    await expect(
      service.executeView(fixture.agentKey, fixture.appSlug, "harmless_label"),
    ).resolves.toMatchObject({
      items: [{note: "attach database is blocked as SQL, not as text"}],
    });

    const checks = await service.checkApps(fixture.agentKey, {
      appSlug: fixture.appSlug,
    });
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "attach_other_db.sql",
        message: "App SQL must not use ATTACH, DETACH, VACUUM INTO, or load_extension().",
      }),
      expect.objectContaining({
        path: "export_db.sql",
        message: "App SQL must not use ATTACH, DETACH, VACUUM INTO, or load_extension().",
      }),
      expect.objectContaining({
        path: "load_native_extension.sql",
        message: "App SQL must not use ATTACH, DETACH, VACUUM INTO, or load_extension().",
      }),
    ]));
  });

  it("creates a blank app scaffold with placeholder files", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "panda-app-create-"));
    tempDirs.push(dataDir);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: dataDir},
    });

    const result = await service.createBlankApp("panda", {
      slug: "sleep-checkin",
      name: "Sleep Check-In",
      description: "Track sleep notes and rough quality.",
      identityScoped: true,
    });

    expect(result.app.slug).toBe("sleep-checkin");
    expect(result.app.name).toBe("Sleep Check-In");
    expect(result.app.identityScoped).toBe(true);
    expect(result.app.hasUi).toBe(true);
    expect(result.schemaApplied).toBe(false);
    expect(result.createdDatabase).toBe(true);

    await access(result.app.dbPath);

    expect(await readFile(result.viewPath, "utf8")).toBe("{}\n");
    expect(await readFile(result.actionPath, "utf8")).toBe("{}\n");
    expect(await readFile(result.schemaPath, "utf8")).toContain("Panda does not run this file automatically yet.");
    expect(await readFile(result.readmePath, "utf8")).toContain("docs/agents/apps.md");

    const apps = await service.listApps("panda");
    expect(apps.map((app) => app.slug)).toEqual(["sleep-checkin"]);
  });

  it("applies optional schemaSql while creating a blank app", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "panda-app-schema-"));
    tempDirs.push(dataDir);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: dataDir},
    });
    const schemaSql = "create table entries (id integer primary key, mood text not null);";

    const result = await service.createBlankApp("panda", {
      slug: "mood-checkin",
      name: "Mood Check-In",
      schemaSql,
    });

    expect(result.schemaApplied).toBe(true);
    expect(await readFile(result.schemaPath, "utf8")).toBe(`${schemaSql}\n`);

    const db = new DatabaseSync(result.app.dbPath);
    try {
      const row = db.prepare(
        "select name from sqlite_master where type = 'table' and name = 'entries'",
      ).get() as {name: string} | undefined;
      expect(row).toEqual({name: "entries"});
    } finally {
      db.close();
    }
  });

  it("blocks app_create schema SQL from using SQLite file escape hatches", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "panda-app-schema-guard-"));
    tempDirs.push(dataDir);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: dataDir},
    });

    await expect(service.createBlankApp("panda", {
      slug: "bad-schema",
      name: "Bad Schema",
      schemaSql: "attach database '/tmp/other.sqlite' as other;",
    })).rejects.toThrow("App SQL must not use ATTACH");

    const apps = await service.listApps("panda");
    expect(apps).toEqual([]);
  });

  it("surfaces structured diagnostics for broken app definitions without hiding valid apps", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "panda-app-diagnostics-"));
    tempDirs.push(dataDir);

    const fixture = await createAgentAppFixture({
      dataDir,
      agentKey: "panda",
      appSlug: "counter",
    });
    fixtures.push(fixture);

    const brokenDir = path.join(dataDir, "agents", "panda", "apps", "broken-tracker");
    await mkdir(path.join(brokenDir, "data"), {recursive: true});
    await writeFile(path.join(brokenDir, "manifest.json"), JSON.stringify({
      name: "Broken Tracker",
    }, null, 2));
    await writeFile(path.join(brokenDir, "views.json"), "{}\n");
    await writeFile(path.join(brokenDir, "actions.json"), JSON.stringify({
      log_entry: {
        mode: "native",
        sql: "select 1",
        inputSchema: {
          type: "object",
          properties: {
            notes: {
              type: ["string", "null"],
            },
          },
        },
      },
    }, null, 2));

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: dataDir},
    });

    const apps = await service.listApps("panda");
    expect(apps.map((app) => app.slug)).toEqual(["counter"]);

    const inspection = await service.inspectApps("panda");
    expect(inspection.apps.map((app) => app.slug)).toEqual(["counter"]);
    expect(inspection.brokenApps).toHaveLength(1);
    expect(inspection.brokenApps[0]).toMatchObject({
      appSlug: "broken-tracker",
      ok: false,
    });
    expect(inspection.brokenApps[0]?.errors).toContainEqual(expect.objectContaining({
      path: "log_entry.inputSchema.properties.notes",
      message: expect.stringContaining("Union types like [\"string\", \"null\"] are not supported"),
    }));
    expect(inspection.brokenApps[0]?.errors.some((issue) => issue.message === "Invalid input")).toBe(false);
  });

  it("checks prepared SQL for loaded apps", async () => {
    const fixture = await createAgentAppFixture({
      views: {
        summary: {
          sql: "select count(*) as count from missing_table",
        },
      },
      actions: {
        increment: {
          mode: "native",
          sql: "update missing_table set value = 1",
        },
      },
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    const checks = await service.checkApps(fixture.agentKey, {
      appSlug: fixture.appSlug,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: fixture.appDir + "/views.json",
        path: "summary.sql",
      }),
      expect.objectContaining({
        file: fixture.appDir + "/actions.json",
        path: "increment.sql",
      }),
    ]));
  });
});
