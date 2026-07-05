import {describe, expect, it} from "vitest";

import {createCommandCatalog, type CommandCatalogModule} from "../src/domain/commands/index.js";
import type {DaemonOptions} from "../src/app/runtime/index.js";

describe("DaemonOptions", () => {
  it("retains the legacy commandModules compatibility option", () => {
    const module = {
      descriptor: {
        name: "custom.echo",
        summary: "Echo text",
        description: "Echo text for a custom command module.",
        usage: "custom echo --text <text>",
        inputModes: ["flags", "json"],
        outputModes: ["text", "json"],
        arguments: [
          {
            name: "text",
            description: "Text to echo.",
            kind: "option",
            valueType: "string",
            required: true,
          },
        ],
        examples: [
          {
            description: "Echo text.",
            command: "panda custom echo --text hello",
          },
        ],
      },
      route: {
        helpArgv: ["custom", "echo"],
        jsonArgv: ["custom", "echo", "--json", "@payload.json"],
      },
      policy: {
        capability: "custom.echo",
      },
    } satisfies CommandCatalogModule;

    const options = {
      cwd: "/tmp/panda",
      commandModules: [module],
    } satisfies DaemonOptions;

    expect(options.commandModules?.[0]?.descriptor.name).toBe("custom.echo");
  });

  it("accepts a supplied command catalog", () => {
    const module = {
      descriptor: {
        name: "custom.echo",
        summary: "Echo text",
        description: "Echo text for a custom command module.",
        usage: "custom echo --text <text>",
        inputModes: ["flags", "json"],
        outputModes: ["text", "json"],
        arguments: [],
        examples: [],
      },
      route: {
        helpArgv: ["custom", "echo"],
        jsonArgv: ["custom", "echo", "--json", "@payload.json"],
      },
      policy: {
        capability: "custom.echo",
      },
    } satisfies CommandCatalogModule;

    const options = {
      cwd: "/tmp/panda",
      commandCatalog: createCommandCatalog([module]),
    } satisfies DaemonOptions;

    expect(options.commandCatalog.get("custom.echo")?.descriptor.name).toBe("custom.echo");
  });
});
