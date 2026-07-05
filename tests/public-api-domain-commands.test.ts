import {describe, expect, it} from "vitest";

import * as commandExports from "../src/domain/commands/index.js";

const EXPECTED_COMMAND_EXPORTS = [
  "DEFAULT_COMMAND_REGISTRATION_PHASE",
  "commandDescriptorToJson",
  "commandDescriptorsFromModules",
  "commandNamesForRegistrationPhase",
  "commandNamesForToolGroups",
  "commandRegistrationPhase",
  "commandRoutesFromModules",
  "combineCommandModules",
  "buildCommandRouteTree",
  "createCommandCatalog",
  "createCommandsFromModules",
  "createStaticCommandRegistry",
  "defineCommandCatalogModule",
  "defineCommandModule",
  "formatCommandHelp",
  "isCommandAllowed",
] as const;

describe("domain command public API", () => {
  it("matches the intentional command module export surface", () => {
    expect(Object.keys(commandExports).sort()).toEqual([...EXPECTED_COMMAND_EXPORTS].sort());
  });
});
