import {execFile} from "node:child_process";
import path from "node:path";
import {promisify} from "node:util";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {createSessionCompactCommand} from "../src/domain/sessions/compaction-commands.js";
import {startCommandHttpServer, type CommandHttpServer} from "../src/integrations/commands/http-server.js";
import {createTestCommandLeaseVerifier} from "./helpers/command-lease-verifier.js";

const exec = promisify(execFile);
const shim = path.resolve("scripts/agent-command-shim/panda");

describe("session compaction CLI transport", () => {
  let server: CommandHttpServer;
  const requests: Array<{sessionId: string; instructions: string}> = [];
  beforeAll(async () => {
    server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands: [createSessionCompactCommand({
        async request(sessionId, _runId, instructions) {
          requests.push({sessionId, instructions});
          return {id: "request", outcomeId: "outcome", sessionId, instructions};
        },
      })]}),
      leaseVerifier: createTestCommandLeaseVerifier([["test-token", {
        agentKey: "panda", sessionId: "session", threadId: "thread", runId: "run",
        allowedCommands: ["session.compact"],
      }]]),
    });
  });
  afterAll(async () => { await server?.close(); });

  function call(args: string[]) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PANDA_COMMAND_")));
    return exec(shim, ["session", "compact", ...args], {env: {...env, PANDA_COMMAND_URL: server.url, PANDA_COMMAND_TOKEN: "test-token"}});
  }

  it("accepts no input, native instructions, and structured JSON", async () => {
    for (const args of [["current"], ["current", "--instructions", "Keep failures.\nDo not deploy."], ["current", "--json", '{"instructions":"Keep decisions."}']]) {
      const response = await call(args);
      expect(JSON.parse(response.stdout)).toEqual({status: "requested", applyAt: "next_model_boundary"});
    }
    expect(requests).toEqual([
      {sessionId: "session", instructions: ""},
      {sessionId: "session", instructions: "Keep failures.\nDo not deploy."},
      {sessionId: "session", instructions: "Keep decisions."},
    ]);
  });

  it("rejects alternate targets and ambiguous input", async () => {
    for (const args of [["other"], ["current", "--instructions"], ["current", "--instructions", "one", "--json", "{}"], ["current", "--json", '{"sessionId":"other"}']]) {
      await expect(call(args)).rejects.toThrow();
    }
  });

  it("discovers the command through authenticated help", async () => {
    expect(JSON.parse((await call(["current", "--help", "--json"])).stdout)).toMatchObject({name: "session.compact", usage: "panda session compact current [--instructions <text>]"});
  });
});
