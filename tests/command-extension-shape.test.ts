import {describe, expect, it} from "vitest";

import {
  createDefaultAgentCommandCatalog,
  agentCommandPolicy,
} from "../src/panda/index.js";
import {
  defineCommandCatalogModule,
  type CommandDescriptor,
} from "../src/domain/commands/index.js";

const descriptor: CommandDescriptor = {
  name: "custom.echo",
  summary: "Echo custom text.",
  description: "Echo custom text.",
  usage: "panda custom echo <text>",
  inputModes: ["json"],
  outputModes: ["json"],
  arguments: [],
  examples: [],
};

describe("public command extension shape", () => {
  it("composes explicit command catalog modules without a plugin loader", () => {
    const module = defineCommandCatalogModule({
      descriptor,
      helpArgv: ["custom", "echo"],
      policy: agentCommandPolicy(["core"]),
    });

    const catalog = createDefaultAgentCommandCatalog({
      extraModules: [module],
    });

    expect(catalog.get("custom.echo")).toBe(module);
    expect(catalog.routes().at(-1)).toEqual({
      command: "custom.echo",
      helpArgv: ["custom", "echo"],
      jsonArgv: ["custom", "echo", "--json", "@payload.json"],
    });
    expect(catalog.namesForToolGroups(["core"])).toContain("custom.echo");
  });
});
