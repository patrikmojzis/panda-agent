import {describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import type {JsonObject} from "../src/lib/json.js";
import {createHeartbeatSetCommand, createHeartbeatShowCommand} from "../src/domain/scheduling/heartbeats/commands.js";
import {resolveHeartbeatCadenceBounds} from "../src/domain/scheduling/heartbeats/config.js";
import type {SessionStore} from "../src/domain/sessions/store.js";
import type {SessionHeartbeatRecord} from "../src/domain/sessions/types.js";

function harness(enabled = true, bounds = resolveHeartbeatCadenceBounds({})) {
  const records = new Map<string, SessionHeartbeatRecord>(["session-one", "session-two"].map((sessionId) => [sessionId, {
    sessionId,
    enabled,
    everyMinutes: 60,
    nextFireAt: Date.parse("2026-09-04T13:00:00Z"),
    configRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  }]));
  const sessions: Pick<SessionStore, "getHeartbeat" | "updateHeartbeatConfig"> = {
    async getHeartbeat(sessionId) { return records.get(sessionId) ?? null; },
    async updateHeartbeatConfig(input) {
      const current = records.get(input.sessionId);
      if (!current) throw new Error("Unknown session");
      const updated = {
        ...current,
        everyMinutes: input.everyMinutes ?? current.everyMinutes,
        enabled: input.enabled ?? current.enabled,
        lastCadenceChangeReason: input.lastCadenceChangeReason ?? current.lastCadenceChangeReason,
        configRevision: current.configRevision + 1,
      };
      records.set(input.sessionId, updated);
      return updated;
    },
  };
  const dispatcher = new RuntimeCommandDispatcher({commands: [
    createHeartbeatShowCommand(sessions, bounds),
    createHeartbeatSetCommand(sessions, bounds),
  ]});
  return {
    execute(command: "heartbeat.show" | "heartbeat.set", input: JsonObject, sessionId = "session-one", allowedCommands = ["heartbeat.show", "heartbeat.set"] as const) {
      return dispatcher.execute({command, input, scope: {agentKey: "panda", sessionId, allowedCommands}});
    },
  };
}

describe("heartbeat commands", () => {
  it("shows actual cadence, enabled state, next time, reason, and limits", async () => {
    const {execute} = harness();
    await expect(execute("heartbeat.show", {})).resolves.toMatchObject({
      ok: true,
      output: {sessionId: "session-one", enabled: true, everyMinutes: 60, nextFireAt: "2026-09-04T13:00:00.000Z", lastCadenceChangeReason: null, minEveryMinutes: 15, maxEveryMinutes: 1_440},
    });
  });

  it("updates only the calling session and returns the saved reason", async () => {
    const {execute} = harness();
    await expect(execute("heartbeat.set", {everyMinutes: 15, reason: "  Active investigation  "})).resolves.toMatchObject({
      ok: true, output: {sessionId: "session-one", everyMinutes: 15, lastCadenceChangeReason: "Active investigation"},
    });
    await expect(execute("heartbeat.show", {})).resolves.toMatchObject({ok: true, output: {everyMinutes: 15}});
    await expect(execute("heartbeat.show", {}, "session-two")).resolves.toMatchObject({ok: true, output: {everyMinutes: 60, lastCadenceChangeReason: null}});
  });

  it("saves cadence while making it clear disabled heartbeats stay off", async () => {
    const {execute} = harness(false);
    await expect(execute("heartbeat.set", {everyMinutes: 240, reason: "Quiet period"})).resolves.toMatchObject({
      ok: true, output: {enabled: false, everyMinutes: 240}, summary: expect.stringContaining("remain disabled"),
    });
  });

  it("enforces the operator's configured bounds", async () => {
    const {execute} = harness(true, {minEveryMinutes: 30, maxEveryMinutes: 120});
    await expect(execute("heartbeat.set", {everyMinutes: 15, reason: "Too frequent"})).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
    await expect(execute("heartbeat.set", {everyMinutes: 240, reason: "Too slow"})).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
    await expect(execute("heartbeat.set", {everyMinutes: 120, reason: "Quiet period"})).resolves.toMatchObject({ok: true, output: {everyMinutes: 120, minEveryMinutes: 30, maxEveryMinutes: 120}});
  });

  it.each([
    {everyMinutes: 0, reason: "invalid"},
    {everyMinutes: 14, reason: "invalid"},
    {everyMinutes: 1_441, reason: "invalid"},
    {everyMinutes: 15.5, reason: "invalid"},
    {everyMinutes: Number.MAX_SAFE_INTEGER + 1, reason: "invalid"},
    {everyMinutes: "15", reason: "invalid"},
    {everyMinutes: 15},
    {everyMinutes: 15, reason: "   "},
    {everyMinutes: 15, reason: "x".repeat(501)},
    {everyMinutes: 15, reason: "first\nsecond"},
    {everyMinutes: 15, reason: "invalid\0reason"},
    {everyMinutes: 15, reason: "valid", sessionId: "session-two"},
    {everyMinutes: 15, reason: "valid", enabled: true},
    {every: "15m", reason: "invalid"},
  ])("rejects invalid heartbeat input %j without changing cadence", async (input) => {
    const {execute} = harness();
    await expect(execute("heartbeat.set", input)).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
    await expect(execute("heartbeat.show", {})).resolves.toMatchObject({ok: true, output: {everyMinutes: 60, lastCadenceChangeReason: null}});
  });

  it("rejects scope fields on show and reports absent configuration", async () => {
    const {execute} = harness();
    await expect(execute("heartbeat.show", {sessionId: "session-two"})).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
    await expect(execute("heartbeat.show", {}, "missing")).resolves.toMatchObject({ok: false, error: {code: "invalid_input"}});
  });
});

describe("heartbeat cadence bounds", () => {
  it("uses defaults and accepts operator-configured limits", () => {
    expect(resolveHeartbeatCadenceBounds({})).toEqual({minEveryMinutes: 15, maxEveryMinutes: 1_440});
    expect(resolveHeartbeatCadenceBounds({PANDA_HEARTBEAT_MIN_EVERY_MINUTES: "30", PANDA_HEARTBEAT_MAX_EVERY_MINUTES: "720"})).toEqual({minEveryMinutes: 30, maxEveryMinutes: 720});
  });

  it.each(["", "0", "-1", "1.5", "Infinity", "15m", "2147483648", "9007199254740992"])("rejects invalid operator limit %j", (value) => {
    expect(() => resolveHeartbeatCadenceBounds({PANDA_HEARTBEAT_MIN_EVERY_MINUTES: value})).toThrow("PANDA_HEARTBEAT_MIN_EVERY_MINUTES");
    expect(() => resolveHeartbeatCadenceBounds({PANDA_HEARTBEAT_MAX_EVERY_MINUTES: value})).toThrow("PANDA_HEARTBEAT_MAX_EVERY_MINUTES");
  });

  it("rejects inverted operator limits", () => {
    expect(() => resolveHeartbeatCadenceBounds({PANDA_HEARTBEAT_MIN_EVERY_MINUTES: "120", PANDA_HEARTBEAT_MAX_EVERY_MINUTES: "60"})).toThrow("must not exceed");
  });
});
