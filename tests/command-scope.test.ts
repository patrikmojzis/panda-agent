import {describe, expect, it} from "vitest";

import {resolveRuntimeCommandScope} from "../src/app/runtime/command-scope.js";
import type {CommandScope} from "../src/domain/commands/types.js";
import type {ExecutionEnvironmentRecord, SessionEnvironmentBindingRecord} from "../src/domain/execution-environments/types.js";
import type {SessionRecord} from "../src/domain/sessions/types.js";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-main",
    agentKey: "panda",
    kind: "main",
    currentThreadId: "thread-current",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function binding(overrides: Partial<SessionEnvironmentBindingRecord> = {}): SessionEnvironmentBindingRecord {
  return {
    sessionId: "session-main",
    environmentId: "env-worker",
    alias: "self",
    isDefault: true,
    credentialPolicy: {mode: "none"},
    skillPolicy: {mode: "none"},
    toolPolicy: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function environment(overrides: Partial<ExecutionEnvironmentRecord> = {}): ExecutionEnvironmentRecord {
  return {
    id: "env-worker",
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    metadata: {
      filesystem: {
        envDir: "env-worker",
      },
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("resolveRuntimeCommandScope", () => {
  const scope: CommandScope = {
    agentKey: "panda",
    sessionId: "session-main",
    environmentId: "env-worker",
    credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
  };

  it("attaches current thread and bound environment metadata", async () => {
    await expect(resolveRuntimeCommandScope(scope, {
      sessions: {
        getSession: async () => session(),
      },
      executionEnvironments: {
        listBindingsForSession: async () => [binding()],
        getEnvironment: async () => environment(),
      },
    })).resolves.toMatchObject({
      threadId: "thread-current",
      credentialPolicy: {mode: "allowlist", envKeys: ["MCP_TOKEN"]},
      executionEnvironment: {
        id: "env-worker",
        agentKey: "panda",
        kind: "disposable_container",
        state: "ready",
        source: "binding",
        metadata: {
          filesystem: {
            envDir: "env-worker",
          },
        },
      },
    });
  });

  it("rejects command scopes for environments no longer bound to the session", async () => {
    await expect(resolveRuntimeCommandScope(scope, {
      sessions: {
        getSession: async () => session(),
      },
      executionEnvironments: {
        listBindingsForSession: async () => [],
        getEnvironment: async () => environment(),
      },
    })).rejects.toThrow("not bound to the requested session");
  });

  it("rejects expired command scope environments", async () => {
    await expect(resolveRuntimeCommandScope(scope, {
      sessions: {
        getSession: async () => session(),
      },
      executionEnvironments: {
        listBindingsForSession: async () => [binding()],
        getEnvironment: async () => environment({expiresAt: 10}),
      },
      now: () => 11,
    })).rejects.toThrow("execution environment is expired");
  });
});
