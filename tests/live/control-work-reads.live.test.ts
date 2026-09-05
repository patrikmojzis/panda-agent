import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresControlAuthService} from "../../src/domain/control/auth.js";
import {ControlHomeService} from "../../src/domain/control/home-service.js";
import {ControlReadService} from "../../src/domain/control/read-service.js";
import {ControlScheduledTasksService, type ControlScheduledTaskLifecycleStatus} from "../../src/domain/control/scheduled-tasks-service.js";
import type {ControlSessionRecord} from "../../src/domain/control/types.js";
import {ControlWatchesService} from "../../src/domain/control/watches-service.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {PostgresScheduledTaskStore} from "../../src/domain/scheduling/tasks/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {PostgresWatchStore} from "../../src/domain/watches/postgres.js";
import {stringToUserMessage} from "../../src/kernel/agent/helpers/input.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import type {PgQueryable} from "../../src/lib/postgres-query.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const sessionId = "control-work-reads";
const otherSessionId = "control-work-reads-private";
interface LifecycleCase {
  title: string;
  expected: ControlScheduledTaskLifecycleStatus;
  enabled?: boolean;
  completed?: boolean;
  cancelled?: boolean;
  active?: "pending" | "claimed" | "running";
  latest?: "failed" | "succeeded";
  tied?: boolean;
  recurring?: boolean;
}
const lifecycleCases: LifecycleCase[] = [
  {title: "Scheduled", expected: "scheduled"},
  {title: "Disabled", enabled: false, expected: "disabled"},
  {title: "Pending beats disabled", enabled: false, active: "pending", expected: "running"},
  {title: "Claimed is running", active: "claimed", expected: "running"},
  {title: "Running", active: "running", expected: "running"},
  {title: "Completion beats running", completed: true, enabled: false, active: "running", latest: "succeeded", expected: "completed"},
  {title: "Failed completion beats running", completed: true, active: "pending", latest: "failed", expected: "failed"},
  {title: "Cancellation wins", cancelled: true, completed: true, active: "running", latest: "failed", expected: "cancelled"},
  {title: "Unfinished failure is scheduled", latest: "failed", expected: "scheduled"},
  {title: "Completion without runs", completed: true, expected: "completed"},
  {title: "Tied latest run", completed: true, latest: "failed", tied: true, expected: "failed"},
  {title: "Recurring scheduled", recurring: true, expected: "scheduled"},
];

describe("Control work reads on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let controlSession: ControlSessionRecord;
  let scheduled: ControlScheduledTasksService;
  let watches: ControlWatchesService;
  const watchIds: string[] = [];
  const latestRowCounts: number[] = [];
  const tieWinner = "74000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/control-work-reads-live-test", max: 4});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const identity = await new PostgresIdentityStore({pool}).createIdentity({
      id: randomUUID(), handle: "work-reader", displayName: "Work reader fixture",
    });
    for (const [agentKey, id] of [["panda", sessionId], ["private-agent", otherSessionId]]) {
      await agents.bootstrapAgent({agentKey, displayName: agentKey});
      await sessions.createSession({id, agentKey, kind: "branch", currentThreadId: `${id}-thread`});
    }
    await agents.ensurePairing("panda", identity.id);
    const auth = new PostgresControlAuthService({pool});
    const grant = await auth.createGrant({identityId: identity.id, role: "scoped", agentKey: "panda"});
    controlSession = (await auth.loginWithToken(grant.loginToken)).session;
    const tasks = new PostgresScheduledTaskStore({pool});
    const threads = new PostgresThreadRuntimeStore({pool});
    scheduled = new ControlScheduledTasksService({pool, store: tasks});
    const now = new Date();
    for (const [index, item] of lifecycleCases.entries()) {
      const task = await tasks.createTask({
        sessionId, title: item.title, instruction: "Synthetic read fixture",
        schedule: item.recurring ? {kind: "recurring", cron: "* * * * *", timezone: "UTC"}
          : {kind: "once", runAt: "2090-01-01T00:00:00Z"}, enabled: item.enabled ?? true,
      });
      await pool.query("UPDATE runtime.scheduled_tasks SET completed_at = $2, cancelled_at = $3 WHERE id = $1", [
        task.id, item.completed ? new Date(0) : null, item.cancelled ? new Date(0) : null,
      ]);
      const insertRun = async (id: string, status: string, offset: number, createdAt: Date) => {
        const claimed = status === "claimed" || status === "running";
        const started = status === "running" || status === "succeeded";
        const finished = status === "succeeded" || status === "failed";
        const threadId = status === "running" ? `${sessionId}-thread` : null;
        if (threadId) await threads.enqueueInput(threadId, {
          source: "scheduled_task", externalMessageId: id,
          message: stringToUserMessage("Synthetic scheduled occurrence"),
        }, "queue", {inputId: id});
        await pool.query(`INSERT INTO runtime.scheduled_task_runs
          (id, task_id, session_id, scheduled_for, status, created_at,
           claim_token, claimed_at, claimed_by, claim_expires_at,
           resolved_thread_id, resolved_thread_session_id, thread_input_id, thread_input_thread_id,
           lineage_recorded_at, started_at, finished_at, error)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $11, $14, $14, $15, $16)`, [
          id, task.id, sessionId, new Date(now.getTime() + offset), status, createdAt,
          claimed ? randomUUID() : null, claimed ? now : null, claimed ? "control-read-fixture" : null,
          claimed ? new Date(now.getTime() + 60_000) : null,
          threadId, threadId ? sessionId : null, threadId ? id : null,
          started ? now : null, finished ? now : null, status === "failed" ? "Synthetic failure" : null,
        ]);
      };
      if (item.active) await insertRun(randomUUID(), item.active, 0, new Date(now.getTime() - 60_000));
      if (item.latest) await insertRun(`71000000-0000-4000-8000-${String(index).padStart(12, "0")}`, item.latest, 1, now);
      if (item.tied) await insertRun(`f1000000-0000-4000-8000-${String(index).padStart(12, "0")}`, "succeeded", 2, now);
    }

    const watchStore = new PostgresWatchStore({pool});
    const measured: PgQueryable = {async query(sql, values) {
      const result = await pool.query(sql, values);
      if (sql.includes("AS latest_run_id")) latestRowCounts.push(result.rows.length);
      return result;
    }};
    watches = new ControlWatchesService({pool: measured, store: watchStore});
    for (const [index, title] of ["01 busy", "02 tied", "03 empty", "04 private"].entries()) {
      const watch = await watchStore.createWatch({
        sessionId: index === 3 ? otherSessionId : sessionId, title, intervalMinutes: 15,
        source: {kind: "http_json", url: "https://fixture.example.test/value", result: {observation: "scalar", valuePath: "value"}},
        detector: {kind: "percent_change", percent: 10},
      });
      watchIds.push(watch.id);
    }
    await pool.query(`INSERT INTO runtime.watch_runs
      (id, watch_id, session_id, scheduled_for, status, created_at)
      SELECT ('73000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        $1, $2, $3::timestamptz - i * INTERVAL '1 minute', 'no_change',
        $3::timestamptz - i * INTERVAL '1 minute'
      FROM generate_series(1, 600) AS i`, [watchIds[0], sessionId, now]);
    await pool.query(`INSERT INTO runtime.watch_runs
      (id, watch_id, session_id, scheduled_for, status, created_at) VALUES
      ($1, $2, $3, $4, 'changed', $4),
      ('74000000-0000-4000-8000-000000000002', $2, $3, $4, 'failed', $4),
      ('75000000-0000-4000-8000-000000000001', $5, $6, $4, 'failed', $4)`,
    [tieWinner, watchIds[1], sessionId, now, watchIds[3], otherSessionId]);
  });

  afterAll(async () => { await pool?.end(); });

  liveIt("uses one lifecycle meaning for displayed rows, filters and sorting", async () => {
    const all = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {perPage: 100});
    expect(all.meta.total).toBe(lifecycleCases.length);
    for (const item of lifecycleCases) {
      expect(all.data.find((task) => task.title === item.title)?.lifecycleStatus).toBe(item.expected);
    }
    for (const status of new Set(lifecycleCases.map((item) => item.expected))) {
      const filtered = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {lifecycleStatus: status, perPage: 100});
      expect(filtered.data.map((task) => task.title).sort()).toEqual(lifecycleCases.filter((item) => item.expected === status).map((item) => item.title).sort());
      expect(filtered.meta.total).toBe(filtered.data.length);
    }
    const sorted = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {sortBy: "lifecycleStatus", perPage: 100});
    expect(sorted.data.map((task) => task.lifecycleStatus)).toEqual(all.data.map((task) => task.lifecycleStatus).sort());
    const descending = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {sortBy: "lifecycleStatus", sortDirection: "desc", perPage: 100});
    expect(descending.data.map((task) => task.lifecycleStatus)).toEqual(all.data.map((task) => task.lifecycleStatus).sort().reverse());
    const scheduleSorted = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {sortBy: "schedule", perPage: 100});
    const onceIds = all.data.filter((task) => task.schedule.kind === "once").map((task) => task.id).sort();
    const recurringId = all.data.find((task) => task.schedule.kind === "recurring")!.id;
    expect(scheduleSorted.data.map((task) => task.id)).toEqual([recurringId, ...onceIds]);
    const scheduleDescending = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {sortBy: "schedule", sortDirection: "desc", perPage: 100});
    expect(scheduleDescending.data.map((task) => task.id)).toEqual([...onceIds, recurringId]);
  });

  liveIt("breaks latest scheduled-run timestamp ties by ascending id", async () => {
    const result = await scheduled.getScheduledTasks(controlSession, "panda", sessionId, {search: "Tied latest run"});
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({lifecycleStatus: "failed"});
    expect(result.data[0]!.recentRuns.map((run) => run.status)).toEqual(["failed", "succeeded"]);
  });

  liveIt("shows only eligible Home tasks with the current running or scheduled lifecycle", async () => {
    const home = new ControlHomeService({pool, reads: new ControlReadService({pool})});
    const result = await home.getHome(controlSession);

    expect(result.scope.agents.map((agent) => agent.agentKey)).toEqual(["panda"]);
    expect(result.sessions.map((session) => session.sessionId)).toEqual([sessionId]);
    expect(result.upcomingAutomations
      .map(({title, lifecycleStatus}) => ({title, lifecycleStatus}))
      .sort((left, right) => left.title.localeCompare(right.title)))
      .toEqual([
        {title: "Claimed is running", lifecycleStatus: "running"},
        {title: "Recurring scheduled", lifecycleStatus: "scheduled"},
        {title: "Running", lifecycleStatus: "running"},
        {title: "Scheduled", lifecycleStatus: "scheduled"},
        {title: "Unfinished failure is scheduled", lifecycleStatus: "scheduled"},
      ]);
  });

  liveIt("fetches at most one latest run per page watch without losing counts or tie order", async () => {
    latestRowCounts.length = 0;
    const result = await watches.getWatches(controlSession, "panda", sessionId, {perPage: 2, sortBy: "title"});
    expect(result.meta).toMatchObject({total: 3, current_page: 1, last_page: 2});
    expect(result.data.map((watch) => watch.id)).toEqual(watchIds.slice(0, 2));
    expect(result.data[0]).toMatchObject({recentRunCount: 600, eventCount: 0, latestRun: {id: "73000000-0000-4000-8000-000000000001", status: "no_change"}});
    expect(result.data[1]).toMatchObject({recentRunCount: 2, latestRun: {id: tieWinner, status: "changed"}});
    expect(latestRowCounts).toEqual([2]);
  });

  liveIt("keeps a page watch with no runs and excludes private-session history", async () => {
    latestRowCounts.length = 0;
    const result = await watches.getWatches(controlSession, "panda", sessionId, {page: 2, perPage: 2, sortBy: "title"});
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({id: watchIds[2], recentRunCount: 0, eventCount: 0, latestRun: null});
    expect(latestRowCounts).toEqual([0]);
    await expect(watches.getWatches(controlSession, "private-agent", otherSessionId)).rejects.toThrow("not found or is not visible");
    await expect(scheduled.getScheduledTasks(controlSession, "private-agent", otherSessionId)).rejects.toThrow("not found or is not visible");
  });
});
