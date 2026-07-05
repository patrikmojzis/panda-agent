import {describe, expect, it} from "vitest";

import {createTimeNowCommand, TIME_NOW_COMMAND_NAME} from "../src/domain/time/commands.js";

describe("time command", () => {
  it("returns current local datetime information", async () => {
    const command = createTimeNowCommand({
      now: () => new Date("2026-06-24T10:34:56.000Z"),
    });

    const result = await command.execute({
      command: TIME_NOW_COMMAND_NAME,
      input: {},
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      isoTimestamp: "2026-06-24T10:34:56.000Z",
      display: expect.any(String),
      format: "full",
      timeZone: expect.any(String),
      weekday: expect.any(String),
      month: expect.any(String),
    });
  });

  it("supports explicit timezone and display format", async () => {
    const command = createTimeNowCommand({
      now: () => new Date("2026-06-24T10:34:56.000Z"),
    });

    const result = await command.execute({
      command: TIME_NOW_COMMAND_NAME,
      input: {
        timezone: "UTC",
        format: "iso",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toMatchObject({
      display: "2026-06-24T10:34:56.000Z",
      format: "iso",
      isoTimestamp: "2026-06-24T10:34:56.000Z",
      timeZone: "UTC",
    });
  });
});
