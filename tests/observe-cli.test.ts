import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {registerObserveCommand} from "../src/ui/observe/cli.js";

const observeCliMocks = vi.hoisted(() => {
  return {
    runObserveApp: vi.fn(async () => {}),
  };
});

vi.mock("../src/ui/observe/app.js", () => ({
  runObserveApp: observeCliMocks.runObserveApp,
}));

function createProgram(): Command {
  const program = new Command();
  registerObserveCommand(program);
  return program;
}

describe("Observe CLI", () => {
  afterEach(() => {
    observeCliMocks.runObserveApp.mockClear();
  });

  it("passes parsed observe options through to the app runner", async () => {
    await createProgram().parseAsync(
      [
        "observe",
        "--thread",
        "thread-1",
        "--db-url",
        "postgres://observe-db",
        "--once",
        "--tail",
        "25",
      ],
      {from: "user"},
    );

    expect(observeCliMocks.runObserveApp).toHaveBeenCalledWith({
      target: {
        kind: "thread",
        threadId: "thread-1",
      },
      dbUrl: "postgres://observe-db",
      once: true,
      tail: 25,
    });
  });

  it("rejects observe without a target", async () => {
    await expect(createProgram().parseAsync(
      ["observe"],
      {from: "user"},
    )).rejects.toThrow("Pass exactly one of --agent, --session, or --thread.");

    expect(observeCliMocks.runObserveApp).not.toHaveBeenCalled();
  });

  it("rejects observe with more than one target", async () => {
    await expect(createProgram().parseAsync(
      [
        "observe",
        "--agent",
        "panda",
        "--session",
        "session-1",
      ],
      {from: "user"},
    )).rejects.toThrow("Pick one target: --agent, --session, or --thread.");

    expect(observeCliMocks.runObserveApp).not.toHaveBeenCalled();
  });
});
