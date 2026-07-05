import {describe, expect, it} from "vitest";

import {createCommandCatalog, type CommandCatalogModule} from "../src/domain/commands/modules.js";
import type {CommandName, CommandPolicyDescriptor, CommandPolicyModule} from "../src/domain/commands/types.js";
import {resolveCommandLeaseAuthority} from "../src/domain/execution-environments/command-authority.js";

function policyModule(
  name: CommandName,
  policy: CommandPolicyDescriptor = {},
): CommandPolicyModule {
  return {
    descriptor: {name},
    policy,
  };
}

function catalogModule(name: CommandName, policy: CommandPolicyDescriptor = {}): CommandCatalogModule {
  return {
    descriptor: {
      name,
      summary: name,
      description: name,
      usage: `panda ${name}`,
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    },
    route: {
      helpArgv: name.split("."),
      jsonArgv: [...name.split("."), "--json", "@payload.json"],
    },
    policy,
  };
}

describe("command lease authority", () => {
  it("maps allowed policy capabilities to executable command names", () => {
    expect(resolveCommandLeaseAuthority({
      commandModules: [
        policyModule("custom.lookup", {capability: "custom.lookup.read"}),
        policyModule("custom.write"),
      ],
      toolPolicy: {
        allowedTools: ["custom.lookup.read", "custom.write"],
      },
    })).toEqual(["custom.lookup", "custom.write"]);

    expect(resolveCommandLeaseAuthority({
      commandModules: [
        policyModule("custom.lookup", {capability: "custom.lookup.read"}),
      ],
      toolPolicy: {
        allowedTools: ["custom.lookup"],
      },
    })).toEqual([]);
  });

  it("applies command policy gates before granting executable names", () => {
    const commandModules: readonly CommandPolicyModule[] = [
      policyModule("micro-app.link.create", {requiresIdentity: true}),
      policyModule("env.set", {requiresCredentialMutation: true}),
      policyModule("postgres.readonly.query", {requiresReadonlyPostgres: true}),
      policyModule("skill.load", {requiredAgentSkillOperation: "load"}),
      policyModule("skill.set", {requiredAgentSkillOperation: "set"}),
    ];

    expect(resolveCommandLeaseAuthority({
      commandModules,
      readonlyPostgresCommandAllowed: true,
      toolPolicy: {
        allowedTools: [
          "micro-app.link.create",
          "env.set",
          "postgres.readonly.query",
          "skill.load",
          "skill.set",
        ],
        postgresReadonly: {allowed: true},
        agentSkill: {allowedOperations: ["load"]},
      },
    })).toEqual(["postgres.readonly.query", "skill.load"]);

    expect(resolveCommandLeaseAuthority({
      commandModules,
      identityScoped: true,
      credentialMutationAllowed: true,
      readonlyPostgresCommandAllowed: true,
      toolPolicy: {
        allowedTools: [
          "micro-app.link.create",
          "env.set",
          "postgres.readonly.query",
          "skill.load",
          "skill.set",
        ],
        postgresReadonly: {allowed: true},
        agentSkill: {allowedOperations: ["load", "set"]},
      },
    })).toEqual([
      "micro-app.link.create",
      "env.set",
      "postgres.readonly.query",
      "skill.load",
      "skill.set",
    ]);
  });

  it("can resolve authority from a selected command catalog", () => {
    const commandCatalog = createCommandCatalog([
      catalogModule("watch.list"),
      catalogModule("watch.create"),
    ]);

    expect(resolveCommandLeaseAuthority({
      commandCatalog,
      toolPolicy: {
        allowedTools: ["watch.create"],
      },
    })).toEqual(["watch.create"]);
  });

  it("rejects ambiguous catalog and module inputs", () => {
    const commandCatalog = createCommandCatalog([
      catalogModule("watch.list"),
    ]);

    expect(() => resolveCommandLeaseAuthority({
      commandCatalog,
      commandModules: [policyModule("watch.list")],
    })).toThrow("Pass either commandCatalog or commandModules, not both.");
  });
});
