import {describe, expect, it} from "vitest";

import type {
  ExecutionEnvironmentRecord,
  SessionEnvironmentBindingRecord,
} from "../src/domain/execution-environments/types.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import type {SubagentProfileRecord} from "../src/domain/subagents/types.js";
import {buildSubagentProfileSnapshot, buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import {SubagentsContext} from "../src/panda/contexts/subagents-context.js";

const NOW = new Date("2026-05-08T12:00:00.000Z");

function profile(slug = "workspace"): SubagentProfileRecord {
  return {
    slug,
    description: `${slug} profile`,
    prompt: `${slug} prompt body must not render`,
    toolGroups: ["core", "workspace_read"],
    transcriptMode: "none",
    source: "builtin",
    enabled: true,
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
  };
}

function createSubagentSession(input: {
  id: string;
  parentSessionId: string;
  execution?: "agent_workspace" | "isolated_environment";
  environmentId?: string;
  task?: string;
  profileSlug?: string;
  createdAt?: number;
}): SessionRecord {
  const resolvedProfile = profile(input.profileSlug ?? "workspace");
  return {
    id: input.id,
    agentKey: "panda",
    kind: "subagent",
    currentThreadId: `${input.id}-thread`,
    metadata: buildSubagentSessionMetadata({
      role: resolvedProfile.slug,
      task: input.task ?? `Task for ${input.id}`,
      parentSessionId: input.parentSessionId,
      execution: input.execution ?? "agent_workspace",
      environmentId: input.environmentId,
      profile: buildSubagentProfileSnapshot(resolvedProfile),
      resolved: {
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {allowedTools: ["current_datetime"]},
      },
    }),
    createdAt: input.createdAt ?? NOW.getTime() - 15 * 60 * 1_000,
    updatedAt: input.createdAt ?? NOW.getTime() - 15 * 60 * 1_000,
  };
}

function createLegacyWorkerSession(id: string): SessionRecord {
  return {
    id,
    agentKey: "panda",
    kind: "worker",
    currentThreadId: `${id}-thread`,
    metadata: {worker: {parentSessionId: "parent-session", role: "legacy"}},
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
  };
}

function createBinding(
  sessionId: string,
  environmentId: string,
  createdAt = NOW.getTime(),
): SessionEnvironmentBindingRecord {
  return {
    sessionId,
    environmentId,
    alias: "self",
    isDefault: true,
    credentialPolicy: {mode: "allowlist", envKeys: []},
    skillPolicy: {mode: "allowlist", skillKeys: []},
    toolPolicy: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function createEnvironment(
  id: string,
  envDir: string,
  overrides: Partial<ExecutionEnvironmentRecord> = {},
): ExecutionEnvironmentRecord {
  return {
    id,
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    runnerUrl: `http://${id}:8080`,
    runnerCwd: "/workspace",
    rootPath: "/workspace",
    createdBySessionId: "parent-session",
    metadata: {
      filesystem: {
        envDir,
        root: {
          corePath: `/root/.panda/environments/panda/${envDir}`,
          parentRunnerPath: `/environments/${envDir}`,
        },
        workspace: {
          corePath: `/root/.panda/environments/panda/${envDir}/workspace`,
          parentRunnerPath: `/environments/${envDir}/workspace`,
          workerPath: "/workspace",
        },
        inbox: {
          corePath: `/root/.panda/environments/panda/${envDir}/inbox`,
          parentRunnerPath: `/environments/${envDir}/inbox`,
          workerPath: "/inbox",
        },
        artifacts: {
          corePath: `/root/.panda/environments/panda/${envDir}/artifacts`,
          parentRunnerPath: `/environments/${envDir}/artifacts`,
          workerPath: "/artifacts",
        },
      },
    },
    createdAt: NOW.getTime() - 15 * 60 * 1_000,
    updatedAt: NOW.getTime() - 10 * 60 * 1_000,
    ...overrides,
  };
}

describe("SubagentsContext", () => {
  it("renders profiles and all child subagent groups without legacy worker terminology", async () => {
    const sessions = [
      {id: "main-session", agentKey: "panda", kind: "main", currentThreadId: "main-thread", createdAt: NOW.getTime(), updatedAt: NOW.getTime()} satisfies SessionRecord,
      createSubagentSession({id: "workspace-child", parentSessionId: "parent-session", execution: "agent_workspace"}),
      createSubagentSession({id: "isolated-child", parentSessionId: "parent-session", execution: "isolated_environment", environmentId: "env-a"}),
      createSubagentSession({id: "missing-env-child", parentSessionId: "parent-session", execution: "isolated_environment", environmentId: "env-missing"}),
      createSubagentSession({id: "other-parent-child", parentSessionId: "other-parent", execution: "agent_workspace"}),
      createLegacyWorkerSession("legacy-worker"),
    ];
    const bindings = [createBinding("isolated-child", "env-a")];
    const environments = [createEnvironment("env-a", "isolated-child")];
    const profiles = [profile("workspace"), {...profile("custom"), source: "custom" as const, agentKey: "panda"}];

    const context = new SubagentsContext({
      sessions: {listAgentSessions: async () => sessions},
      environments: {
        listDisposableEnvironmentsByOwner: async () => environments,
        listBindingsForEnvironments: async () => bindings,
      },
      subagentProfiles: {listProfiles: async () => profiles},
      agentKey: "panda",
      parentSessionId: "parent-session",
      now: NOW,
    });

    const rendered = await context.getContent();

    expect(rendered).toContain("Available subagent profiles:");
    expect(rendered).toContain("workspace (builtin): workspace profile");
    expect(rendered).toContain("custom (custom): custom profile");
    expect(rendered).not.toContain("prompt body must not render");
    expect(rendered).toContain("Agent workspace subagents:");
    expect(rendered).toContain("workspace-child");
    expect(rendered).toContain("Isolated environment subagents:");
    expect(rendered).toContain("isolated-child");
    expect(rendered).toContain("workspace /environments/isolated-child/workspace");
    expect(rendered).toContain("inbox /environments/isolated-child/inbox");
    expect(rendered).toContain("artifacts /environments/isolated-child/artifacts");
    expect(rendered).toContain("Subagents with unavailable environments:");
    expect(rendered).toContain("missing-env-child");
    expect(rendered).not.toContain("other-parent-child");
    expect(rendered).not.toContain("legacy-worker");
    expect(rendered).not.toContain("Workers");
    expect(rendered).not.toContain("workers none");
  });

  it("caps rendered profiles and subagents", async () => {
    const sessions = [
      createSubagentSession({id: "one", parentSessionId: "parent-session", execution: "isolated_environment", environmentId: "env-shared", createdAt: NOW.getTime() - 30}),
      createSubagentSession({id: "two", parentSessionId: "parent-session", execution: "isolated_environment", environmentId: "env-shared", createdAt: NOW.getTime() - 20}),
      createSubagentSession({id: "three", parentSessionId: "parent-session", execution: "isolated_environment", environmentId: "env-shared", createdAt: NOW.getTime() - 10}),
    ];
    const bindings = [
      createBinding("one", "env-shared", NOW.getTime() - 30),
      createBinding("two", "env-shared", NOW.getTime() - 20),
      createBinding("three", "env-shared", NOW.getTime() - 10),
    ];
    const profiles = Array.from({length: 3}, (_, index) => profile(`profile_${index}`));

    const context = new SubagentsContext({
      sessions: {listAgentSessions: async () => sessions},
      environments: {
        listDisposableEnvironmentsByOwner: async () => [createEnvironment("env-shared", "shared")],
        listBindingsForEnvironments: async () => bindings,
      },
      subagentProfiles: {listProfiles: async () => profiles},
      agentKey: "panda",
      parentSessionId: "parent-session",
      maxProfiles: 2,
      maxSubagentsPerEnvironment: 2,
      now: NOW,
    });

    const rendered = await context.getContent();

    expect(rendered).toContain("1 additional profiles omitted");
    expect(rendered).toContain("three");
    expect(rendered).toContain("two");
    expect(rendered).not.toContain("one | profile");
    expect(rendered).toContain("1 older subagent omitted");
  });
});
