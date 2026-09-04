import {describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {createHeartbeatPromptContextResolver} from "../src/app/runtime/heartbeat-prompt-context.js";
import {createCommandCatalog} from "../src/domain/commands/modules.js";
import type {ExecutionEnvironmentRecord, ExecutionToolPolicy} from "../src/domain/execution-environments/types.js";
import type {SessionRecord} from "../src/domain/sessions/types.js";
import {buildAdHocSubagentProfileSnapshot, buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import {resolveSubagentToolPolicy} from "../src/domain/subagents/tool-groups.js";
import {DEFAULT_AGENT_COMMAND_MODULES} from "../src/panda/commands/agent-command-modules.js";
import {renderHeartbeatPrompt} from "../src/prompts/runtime/heartbeat.js";

const commandCatalog = createCommandCatalog(DEFAULT_AGENT_COMMAND_MODULES.filter((module) => (
  module.descriptor.name === "heartbeat.set"
)));
const session: SessionRecord = {
  id: "session-main",
  agentKey: "panda",
  kind: "main",
  currentThreadId: "thread-main",
  createdAt: 1,
  updatedAt: 1,
};

function createHarness(options: {
  toolPolicy?: ExecutionToolPolicy;
  environment?: Partial<ExecutionEnvironmentRecord>;
  bound?: boolean;
  registered?: boolean;
  promptError?: Error;
} = {}) {
  const environment: ExecutionEnvironmentRecord = {
    id: "environment-main",
    agentKey: "panda",
    kind: "local",
    state: "ready",
    createdAt: 1,
    updatedAt: 1,
    ...options.environment,
  };
  const binding = {
    sessionId: session.id,
    environmentId: environment.id,
    alias: "default",
    isDefault: true,
    credentialPolicy: {mode: "none" as const},
    skillPolicy: {mode: "none" as const},
    toolPolicy: options.toolPolicy ?? resolveSubagentToolPolicy(["core", "operate"], {commandCatalog}),
    createdAt: 1,
    updatedAt: 1,
  };
  const commandExecutor = new RuntimeCommandDispatcher({
    commands: options.registered === false ? [] : commandCatalog.modules.map(({descriptor}) => ({
      descriptor,
      async execute() {
        throw new Error("Prompt discovery must not execute commands.");
      },
    })),
  });
  const resolve = createHeartbeatPromptContextResolver({
    sessions: {
      async readSessionPrompt(sessionId, slug) {
        if (options.promptError) {
          throw options.promptError;
        }
        return {sessionId, slug: slug ?? "heartbeat", content: "  Check pending promises.  ", createdAt: 1, updatedAt: 1};
      },
    },
    executionEnvironments: {
      async getDefaultBinding() {
        return options.bound === false ? null : binding;
      },
      async getBindingByAlias() {
        return null;
      },
      async getEnvironment() {
        return environment;
      },
    },
    commandCatalog,
    commandExecutor,
    env: {BASH_EXECUTION_MODE: "local"},
  });
  return {resolve, environment};
}

describe("heartbeat prompt capability", () => {
  it("preserves session guidance and advertises a registered operate command", async () => {
    await expect(createHarness().resolve(session)).resolves.toEqual({
      guidance: "Check pending promises.",
      canConfigureCadence: true,
    });
  });

  it.each([
    {name: "core-only grant", toolPolicy: resolveSubagentToolPolicy(["core"], {commandCatalog})},
    {name: "missing bash", toolPolicy: resolveSubagentToolPolicy(["operate"], {commandCatalog})},
    {name: "disabled bash", toolPolicy: {allowedTools: ["bash", "heartbeat.set"], bash: {allowed: false}}},
  ])("omits the hint for $name while keeping session guidance", async ({toolPolicy}) => {
    await expect(createHarness({toolPolicy}).resolve(session)).resolves.toEqual({
      guidance: "Check pending promises.",
      canConfigureCadence: false,
    });
  });

  it("omits an unregistered command even when the environment grants it", async () => {
    await expect(createHarness({registered: false}).resolve(session)).resolves.toMatchObject({canConfigureCadence: false});
  });

  it.each([
    {state: "stopped" as const},
    {state: "ready" as const, expiresAt: 1},
    {agentKey: "other-agent"},
  ])("preserves guidance without recovering an unavailable environment: %j", async (environment) => {
    const harness = createHarness({environment});
    const before = {...harness.environment};
    await expect(harness.resolve(session)).resolves.toEqual({guidance: "Check pending promises.", canConfigureCadence: false});
    expect(harness.environment).toEqual(before);
  });

  it("uses default main-session grants when there is no binding", async () => {
    await expect(createHarness({bound: false}).resolve(session)).resolves.toMatchObject({canConfigureCadence: true});
  });

  it("uses the stored subagent grant instead of its profile's operate group", async () => {
    const subagent: SessionRecord = {
      ...session,
      kind: "subagent",
      metadata: buildSubagentSessionMetadata({
        role: "subagent",
        task: "Review pending work.",
        parentSessionId: "session-parent",
        execution: "agent_workspace",
        profile: buildAdHocSubagentProfileSnapshot(["core", "operate"]),
        resolved: {
          credentialPolicy: {mode: "none"},
          skillPolicy: {mode: "none"},
          toolPolicy: resolveSubagentToolPolicy(["core"], {commandCatalog}),
        },
      }),
    };
    await expect(createHarness({bound: false}).resolve(subagent)).resolves.toMatchObject({canConfigureCadence: false});
  });

  it("does not hide a failed session-prompt read", async () => {
    const error = new Error("Session prompt storage unavailable.");
    await expect(createHarness({promptError: error}).resolve(session)).rejects.toBe(error);
  });
});

describe("heartbeat prompt", () => {
  const base = {scheduledIso: "2026-09-04T12:00:00.000Z", everyMinutes: 60};

  it("shows interval and quoted reason without advertising unavailable commands", () => {
    const prompt = renderHeartbeatPrompt({...base, lastChangeReason: "Quiet period", guidance: "Check promises."});
    expect(prompt).toContain('Current heartbeat interval: 60 minutes.\nLast cadence change reason: "Quiet period"');
    expect(prompt).toContain("Check promises.");
    expect(prompt).not.toContain("panda heartbeat set");
  });

  it("adds only the brief cadence hint when the command is available", () => {
    const prompt = renderHeartbeatPrompt({...base, canConfigureCadence: true});
    expect(prompt).toContain("Adjust your heartbeat interval with `panda heartbeat set` when the pace of useful work changes. See `--help` for usage.");
    expect(prompt).not.toContain("Last cadence change reason:");
  });

  it("keeps legacy multiline and oversized reasons bounded and quoted as data", () => {
    const reason = 'Wait for "Alice".\n' + "x".repeat(600);
    const prompt = renderHeartbeatPrompt({...base, lastChangeReason: reason});
    const reasonLine = prompt.split("\n").find((line) => line.startsWith("Last cadence change reason: "))!;
    const renderedReason: string = JSON.parse(reasonLine.slice("Last cadence change reason: ".length));
    expect(renderedReason).toHaveLength(500);
    expect(renderedReason).toContain('Wait for "Alice".\n');
    expect(renderedReason).toMatch(/\.\.\.$/);
  });
});
