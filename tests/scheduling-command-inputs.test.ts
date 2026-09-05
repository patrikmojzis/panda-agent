import {describe, expect, it, vi} from "vitest";

import {createWatchUpdateCommand} from "../src/domain/watches/commands.js";
import type {WatchRecord} from "../src/domain/watches/types.js";
import {createScheduleCreateCommand, createScheduleUpdateCommand} from "../src/domain/scheduling/tasks/commands.js";
import type {ScheduledTaskRecord} from "../src/domain/scheduling/tasks/types.js";

const scope = {agentKey: "panda", sessionId: "session-current"};
const watch: WatchRecord = {
  id: "watch-1", sessionId: scope.sessionId, title: "Watch", intervalMinutes: 5, enabled: true,
  source: {kind: "http_json", url: "https://example.test/value", result: {observation: "scalar", valuePath: "value"}},
  detector: {kind: "percent_change", percent: 5}, createdAt: 0, updatedAt: 0,
};
const task: ScheduledTaskRecord = {
  id: "task-1", sessionId: scope.sessionId, title: "Task", instruction: "Inspect changes.", enabled: true,
  schedule: {kind: "recurring", cron: "0 * * * *", timezone: "UTC"}, createdAt: 0, updatedAt: 0,
};

describe.each([
  {name: "watch.update", idKey: "watchId", create: () => {
    const update = vi.fn(async () => watch);
    return {command: createWatchUpdateCommand({updateWatch: update}), update};
  }},
  {name: "schedule.update", idKey: "taskId", create: () => {
    const update = vi.fn(async () => task);
    return {command: createScheduleUpdateCommand({updateTask: update}), update};
  }},
])("$name string inputs", ({name, idKey, create}) => {
  it.each([undefined, null, "", " \t ", 42, false])("rejects invalid required IDs before mutation: %s", async (value) => {
    const {command, update} = create();
    await expect(command.execute({
      command: name, scope, input: value === undefined ? {} : {[idKey]: value},
    })).rejects.toThrow(`${name} ${idKey} must not be empty.`);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "  Updated title\n"])("normalizes optional title while retaining session authority: %s", async (title) => {
    const {command, update} = create();
    await expect(command.execute({
      command: name, scope, input: {[idKey]: "  resource-id\n", ...(title === undefined ? {} : {title})},
    })).resolves.toMatchObject({ok: true});
    expect(update).toHaveBeenCalledOnce();
    const expected = {[idKey]: "resource-id", title: typeof title === "string" ? title.trim() : undefined};
    if (name === "watch.update") {
      expect(update).toHaveBeenCalledWith(expect.objectContaining(expected), expect.objectContaining(scope));
    } else {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({...expected, sessionId: scope.sessionId}));
    }
  });

  it.each(["", " \t ", 42, false])("rejects present invalid optional strings before mutation: %s", async (title) => {
    const {command, update} = create();
    await expect(command.execute({command: name, scope, input: {[idKey]: "resource-id", title}}))
      .rejects.toThrow(`${name} title must not be empty.`);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("schedule.create nested string inputs", () => {
  it.each([
    {schedule: {kind: "once", runAt: " "}, field: "runAt"},
    {schedule: {kind: "recurring", cron: " ", timezone: " "}, field: "cron"},
    {schedule: {kind: "recurring", cron: "0 * * * *", timezone: " "}, field: "timezone"},
  ])("preserves nested $field errors and validation order", async ({schedule, field}) => {
    const createTask = vi.fn(async () => task);
    await expect(createScheduleCreateCommand({createTask}).execute({
      command: "schedule.create", scope, input: {title: "Task", instruction: "Inspect changes.", schedule},
    })).rejects.toThrow(`schedule.create schedule.${field} must not be empty.`);
    expect(createTask).not.toHaveBeenCalled();
  });
});
