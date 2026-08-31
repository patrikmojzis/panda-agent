import {Command} from "commander";
import {afterEach, describe, expect, it, vi} from "vitest";

import {registerAgentCommands} from "../src/domain/agents/cli.js";
import {
  OPENAI_LIVE_VOICE_CATALOG,
  parseOpenAILiveVoice,
} from "../src/integrations/openai-live/index.js";

describe("agent live voice CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  function program() {
    const command = new Command();
    command.exitOverride();
    command.configureOutput({writeErr: () => undefined});
    registerAgentCommands(command, {
      liveVoice: {...OPENAI_LIVE_VOICE_CATALOG, parse: parseOpenAILiveVoice},
    });
    return command;
  }

  it("lists the provider catalogue as stable JSON", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await program().parseAsync(["agent", "voice", "list", "--json"], {from: "user"});
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      provider: "openai-live",
      model: "gpt-live-1-codex",
      sourceVersion: OPENAI_LIVE_VOICE_CATALOG.sourceVersion,
      defaultVoice: "cove",
      voices: ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"],
    });
  });

  it("rejects unsupported values before opening a database", async () => {
    await expect(program().parseAsync(["agent", "voice", "set", "panda", "marin"], {from: "user"}))
      .rejects.toMatchObject({code: "commander.invalidArgument"});
  });
});
