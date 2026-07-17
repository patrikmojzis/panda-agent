import {describe, expect, it, vi} from "vitest";

import {RuntimeCommandLeaseService} from "../src/app/runtime/command-leases.js";
import {createCommandCatalog, type CommandCatalog, type CommandCatalogModule, type CommandPolicyModule} from "../src/domain/commands/index.js";
import {
  DEFAULT_AGENT_COMMAND_CATALOG,
  DEFAULT_AGENT_COMMAND_MODULES,
} from "../src/panda/commands/agent-command-modules.js";

function createLeaseService(options: {
  baseUrl?: string;
  socketPath?: string;
  readonlyPostgresCommandAllowed?: boolean;
  commandCatalog?: Pick<CommandCatalog, "modules">;
  commandModules?: readonly CommandPolicyModule[];
  now?: () => Date;
} = {}): RuntimeCommandLeaseService {
  return new RuntimeCommandLeaseService({
    ...(options.baseUrl ? {baseUrl: options.baseUrl} : {}),
    ...(options.socketPath ? {socketPath: options.socketPath} : {}),
    ...(options.readonlyPostgresCommandAllowed !== undefined
      ? {readonlyPostgresCommandAllowed: options.readonlyPostgresCommandAllowed}
      : {}),
    ...(options.commandCatalog
      ? {commandCatalog: options.commandCatalog}
      : options.commandModules
        ? {commandModules: options.commandModules}
        : {commandCatalog: DEFAULT_AGENT_COMMAND_CATALOG}),
    ...(options.now ? {now: options.now} : {}),
  });
}

function defaultCommandCapabilities(): string[] {
  return DEFAULT_AGENT_COMMAND_MODULES.flatMap((module) => (
    module.policy ? [module.policy.capability ?? module.descriptor.name] : []
  ));
}

function defaultCommandNamesWhere(
  predicate: (module: (typeof DEFAULT_AGENT_COMMAND_MODULES)[number]) => boolean,
): string[] {
  return DEFAULT_AGENT_COMMAND_MODULES
    .filter(predicate)
    .map((module) => module.descriptor.name);
}

describe("RuntimeCommandLeaseService", () => {
  it("mints command leases from tool policy without identity-scoped app links", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      readonlyPostgresCommandAllowed: true,
      now: () => new Date("2026-06-24T12:00:00.000Z"),
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: defaultCommandCapabilities(),
        postgresReadonly: {
          allowed: true,
        },
      },
    });

    expect(lease).toMatchObject({
      url: "http://127.0.0.1:8096",
      expiresAt: "2026-06-24T13:00:00.000Z",
    });
    expect(lease?.token).toMatch(/^panda-command-v1\./);
    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      allowedCommands: defaultCommandNamesWhere((module) => (
        module.policy.requiresIdentity !== true
        && module.policy.requiresCredentialMutation !== true
      )),
      credentialMutationAllowed: false,
    });
  });

  it("round-trips execution credential policy in the signed lease scope", async () => {
    const service = createLeaseService({baseUrl: "http://127.0.0.1:8096"});
    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-subagent",
      credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
      toolPolicy: {allowedTools: ["mcp.*"]},
    });
    expect(lease).not.toBeNull();
    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
      allowedCommands: ["mcp.tools", "mcp.call"],
    });
  });

  it("can lease every default command when module policy requirements are satisfied", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      readonlyPostgresCommandAllowed: true,
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      identityId: "identity-current",
      credentialMutationAllowed: true,
      toolPolicy: {
        allowedTools: defaultCommandCapabilities(),
        postgresReadonly: {
          allowed: true,
        },
      },
    });

    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      allowedCommands: defaultCommandNamesWhere(() => true),
    });
  });

  it("mints leases from a caller-supplied command module catalog", async () => {
    const customModule: CommandPolicyModule = {
      descriptor: {name: "custom.lookup"},
      policy: {
        capability: "custom.lookup",
      },
    };
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      commandModules: [customModule],
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["custom.lookup", "watch.list"],
      },
    });

    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      allowedCommands: ["custom.lookup"],
    });
  });

  it("maps policy capabilities to executable command names", async () => {
    const customModule: CommandPolicyModule = {
      descriptor: {name: "custom.lookup"},
      policy: {
        capability: "custom.lookup.read",
      },
    };
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      commandModules: [customModule],
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["custom.lookup.read"],
      },
    });

    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      allowedCommands: ["custom.lookup"],
    });
    expect(service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["custom.lookup"],
      },
    })).toBeNull();
  });

  it("mints leases from a caller-supplied command catalog", async () => {
    const customModule: CommandCatalogModule = {
      descriptor: {
        name: "custom.lookup",
        summary: "Lookup custom data.",
        description: "Lookup custom data.",
        usage: "panda custom lookup",
        inputModes: ["json"],
        outputModes: ["json"],
        arguments: [],
        examples: [],
      },
      route: {
        helpArgv: ["custom", "lookup"],
        jsonArgv: ["custom", "lookup", "--json", "@payload.json"],
      },
      policy: {
        capability: "custom.lookup",
      },
    };
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      commandCatalog: createCommandCatalog([customModule]),
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["custom.lookup", "watch.list"],
      },
    });

    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      allowedCommands: ["custom.lookup"],
    });
  });

  it("does not translate removed message_agent policy names into A2A commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["message_agent"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed environment policy names into environment commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["environment_create", "environment_stop"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed current_datetime policy names into time commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["current_datetime"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed vent policy names into vent commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["vent"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed web policy names into web commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["web_fetch", "brave_search", "web_research"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed media policy names into media commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["image_generate", "whisper"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed wiki policy names into wiki commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["wiki"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed outbound policy names into channel commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["outbound"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed agent-management policy names into commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: [
          "agent_skill",
          "session_prompt",
          "todo_update",
          "upsert_subagent_profile",
          "spawn_subagent",
        ],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed channel and env policy names into commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      readonlyPostgresCommandAllowed: true,
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: [
          "telegram_react",
          "email_send",
          "set_env_value",
          "clear_env_value",
        ],
      },
    });

    expect(lease).toBeNull();
  });

  it("only includes micro-app.link.create when the lease is scoped to a current input identity", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const generic = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["micro-app.link.create", "micro-app.view"],
      },
    });
    const identityScoped = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      identityId: "identity-current",
      inputMessageId: "message-123",
      toolPolicy: {
        allowedTools: ["micro-app.link.create", "micro-app.view"],
      },
    });

    await expect(service.verify(generic!.token)).resolves.toMatchObject({
      allowedCommands: ["micro-app.view"],
    });
    await expect(service.verify(identityScoped!.token)).resolves.toMatchObject({
      identityId: "identity-current",
      inputMessageId: "message-123",
      allowedCommands: ["micro-app.link.create", "micro-app.view"],
    });
  });

  it("includes env list without mutation and env mutation commands only when explicitly allowed", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const denied = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["env.list", "env.set", "env.clear"],
      },
    });
    const allowed = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-b",
      credentialMutationAllowed: true,
      toolPolicy: {
        allowedTools: ["env.list", "env.set", "env.clear"],
      },
    });

    await expect(service.verify(denied!.token)).resolves.toMatchObject({
      allowedCommands: ["env.list"],
      credentialMutationAllowed: false,
    });
    await expect(service.verify(allowed!.token)).resolves.toMatchObject({
      allowedCommands: ["env.list", "env.set", "env.clear"],
      credentialMutationAllowed: true,
    });
  });

  it("narrows agent skill commands to allowed operations and carries skill policy", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
      toolPolicy: {
        allowedTools: ["skill.list", "skill.show", "skill.load", "skill.set", "skill.patch", "skill.delete"],
        agentSkill: {
          allowedOperations: ["load", "patch", "bogus" as never],
        },
      },
    });

    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      allowedCommands: ["skill.list", "skill.show", "skill.load", "skill.patch"],
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
      agentSkillAllowedOperations: ["load", "patch"],
    });
  });

  it("only includes readonly postgres command when readonly command access is enabled", async () => {
    const denied = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    }).issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["postgres.readonly.query"],
        postgresReadonly: {
          allowed: true,
        },
      },
    });
    const allowedService = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      readonlyPostgresCommandAllowed: true,
    });
    const allowed = allowedService.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-b",
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
      toolPolicy: {
        allowedTools: ["postgres.readonly.query"],
        postgresReadonly: {
          allowed: true,
        },
      },
    });

    expect(denied).toBeNull();
    await expect(allowedService.verify(allowed!.token)).resolves.toMatchObject({
      allowedCommands: ["postgres.readonly.query"],
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
    });
  });

  it("does not translate removed readonly postgres policy names into postgres commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      readonlyPostgresCommandAllowed: true,
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["postgres_readonly_query"],
        postgresReadonly: {
          allowed: true,
        },
      },
    });

    expect(lease).toBeNull();
  });

  it("does not mint leases without a command server or command allowlist", () => {
    expect(createLeaseService().issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["bash"],
      },
    })).toBeNull();

    expect(createLeaseService({baseUrl: "http://127.0.0.1:8096"}).issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["bash"],
      },
    })).toBeNull();
  });

  it("mints socket-only leases without an HTTP URL", async () => {
    const service = createLeaseService({
      socketPath: "/tmp/panda-command.sock",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      toolPolicy: {
        allowedTools: ["watch.list", "watch.show", "watch.runs", "watch.create"],
      },
    });

    expect(lease).toMatchObject({
      socketPath: "/tmp/panda-command.sock",
    });
    expect(lease?.url).toBeUndefined();
    await expect(service.verify(lease!.token)).resolves.toMatchObject({
      allowedCommands: ["watch.list", "watch.show", "watch.runs", "watch.create"],
    });
  });

  it("expires minted leases", async () => {
    const now = vi.fn(() => new Date("2026-06-24T12:00:00.000Z"));
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
      now,
    });
    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      environmentId: "env-a",
      ttlMs: 1_000,
      toolPolicy: {
        allowedTools: ["watch.create"],
      },
    });

    now.mockReturnValue(new Date("2026-06-24T12:00:01.001Z"));

    await expect(service.verify(lease!.token)).resolves.toBeUndefined();
  });

  it("does not translate removed watch tool policy names into watch commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["watch_create", "watch_update", "watch_disable", "watch_schema_get"],
      },
    });

    expect(lease).toBeNull();
  });

  it("does not translate removed scheduled task policy names into schedule commands", async () => {
    const service = createLeaseService({
      baseUrl: "http://127.0.0.1:8096",
    });

    const lease = service.issueCommandLease({
      agentKey: "panda",
      sessionId: "session-main",
      toolPolicy: {
        allowedTools: ["scheduled_task_create", "scheduled_task_update", "scheduled_task_cancel"],
      },
    });

    expect(lease).toBeNull();
  });
});
