import process from "node:process";
import {readFile} from "node:fs/promises";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../runtime/postgres-bootstrap.js";
import {
  summarizeSubagentPurgeCounts,
  type SubagentPurgeCandidate,
  type SubagentPurgeInput,
  type SubagentPurgePlan,
  SubagentPurgeService,
} from "../runtime/subagent-purge-service.js";
import {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/postgres.js";
import {PostgresExecutionEnvironmentStore} from "../../domain/execution-environments/postgres.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import {PostgresIdentityStore} from "../../domain/identity/postgres.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import {PostgresSubagentProfileStore} from "../../domain/subagents/postgres.js";
import type {SubagentProfileRecord} from "../../domain/subagents/types.js";
import {createExecutionEnvironmentManagerClientFromEnv} from "../../integrations/shell/execution-environment-manager-client.js";
import {parseAgentKey} from "../../domain/agents/cli.js";
import {parseRequiredOptionValue, parseSessionIdOption} from "../../lib/cli.js";
import {resolveModelSelector} from "../../kernel/models/model-selector.js";

interface SubagentPurgeCliOptions {
  dbUrl?: string;
  dryRun?: boolean;
  execute?: boolean;
  agent?: string;
  sessionId?: string;
  environmentId?: string;
  stopped?: boolean;
  expired?: boolean;
  olderThan?: number;
  force?: boolean;
  skipFiles?: boolean;
}

const DURATION_UNITS = new Map<string, number>([
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 60 * 60_000],
  ["d", 24 * 60 * 60_000],
  ["w", 7 * 24 * 60 * 60_000],
]);

export function parseDurationOption(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)(ms|s|m|h|d|w)?$/.exec(trimmed);
  if (!match) {
    throw new InvalidArgumentError("Expected a duration like 12h, 7d, 30m, or 1000ms.");
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = DURATION_UNITS.get(unit);
  if (!Number.isSafeInteger(amount) || amount < 1 || multiplier === undefined) {
    throw new InvalidArgumentError("Expected a positive duration.");
  }
  const durationMs = amount * multiplier;
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new InvalidArgumentError("Duration is too large.");
  }
  return durationMs;
}

function formatAge(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe >= 7 * 24 * 60 * 60_000) {
    return `${Math.floor(safe / (7 * 24 * 60 * 60_000))}w`;
  }
  if (safe >= 24 * 60 * 60_000) {
    return `${Math.floor(safe / (24 * 60 * 60_000))}d`;
  }
  if (safe >= 60 * 60_000) {
    return `${Math.floor(safe / (60 * 60_000))}h`;
  }
  if (safe >= 60_000) {
    return `${Math.floor(safe / 60_000)}m`;
  }
  if (safe >= 1_000) {
    return `${Math.floor(safe / 1_000)}s`;
  }
  return `${safe}ms`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatExternalFileReferenceCount(count: number | null): string {
  return count === null ? "not scanned in dry-run" : String(count);
}

function formatCandidate(candidate: SubagentPurgeCandidate, now: number): string {
  const counts = candidate.dbCounts;
  const lines = [
    `- environment ${candidate.environment.id} (${candidate.agentKey})`,
    `  sessions: ${candidate.sessionIds.length ? candidate.sessionIds.join(", ") : "none"}`,
    `  state: ${candidate.environment.state}`,
    `  age: ${formatAge(now - candidate.environment.updatedAt)}`,
    `  updatedAt: ${new Date(candidate.environment.updatedAt).toISOString()}`,
    `  expiresAt: ${candidate.environment.expiresAt === undefined ? "none" : new Date(candidate.environment.expiresAt).toISOString()}`,
    `  container: ${candidate.containerName ?? "unknown"}`,
    `  envRoot: ${candidate.filesystem.rootPath ?? "unknown"}`,
    `  files: ${candidate.filesystem.status}${candidate.filesystem.reason ? ` (${candidate.filesystem.reason})` : ""}`,
    `  envRootBytes: ${formatBytes(candidate.filesystem.bytes)}`,
    `  dbRows: sessions=${counts.sessions}, threads=${counts.threads}, messages=${counts.messages}, inputs=${counts.inputs}, runs=${counts.runs}, toolJobs=${counts.toolJobs}, bashJobs=${counts.bashJobs}, outbound=${counts.outboundDeliveries}, runtimeRequests=${counts.runtimeRequests}, envBindings=${counts.sessionEnvironmentBindings}, a2aBindings=${counts.a2aSessionBindings}`,
    `  externalFileRefs: ${formatExternalFileReferenceCount(candidate.externalFileReferenceCount)}`,
  ];
  if (candidate.refusedReason) {
    lines.push(`  refused: ${candidate.refusedReason}`);
  }
  return lines.join("\n");
}

function renderPurgePlan(plan: SubagentPurgePlan): string {
  const counts = summarizeSubagentPurgeCounts(plan.candidates);
  const totalBytes = plan.candidates.reduce((sum, candidate) => sum + (candidate.filesystem.bytes ?? 0), 0);
  const header = [
    plan.dryRun ? "Subagent purge dry-run" : "Subagent purge executed",
    `Candidates: ${plan.candidates.length}`,
    `Environment-root bytes: ${formatBytes(totalBytes)}`,
    `DB rows: sessions=${counts.sessions}, threads=${counts.threads}, messages=${counts.messages}, inputs=${counts.inputs}, runs=${counts.runs}, toolJobs=${counts.toolJobs}, bashJobs=${counts.bashJobs}, outbound=${counts.outboundDeliveries}, runtimeRequests=${counts.runtimeRequests}, envs=${counts.executionEnvironments}`,
  ];
  const body = plan.candidates.map((candidate) => formatCandidate(candidate, plan.now));
  const footer = plan.dryRun
    ? ["No changes were made. Re-run with --execute to purge these candidates."]
    : ["Purge completed."];
  return [...header, "", ...body, "", ...footer].join("\n").trimEnd() + "\n";
}

export function buildPurgeInput(options: SubagentPurgeCliOptions): SubagentPurgeInput {
  if (options.execute && options.dryRun) {
    throw new Error("Use either --dry-run or --execute, not both.");
  }
  const input: SubagentPurgeInput = {
    execute: options.execute === true,
    force: options.force === true,
    skipFiles: options.skipFiles === true,
    selector: {
      ...(options.agent ? {agentKey: options.agent} : {}),
      ...(options.sessionId ? {sessionId: options.sessionId} : {}),
      ...(options.environmentId ? {environmentId: options.environmentId} : {}),
      ...(options.stopped ? {stopped: true} : {}),
      ...(options.expired ? {expired: true} : {}),
      ...(options.olderThan !== undefined ? {olderThanMs: options.olderThan} : {}),
    },
  };
  if (Object.keys(input.selector).length === 0) {
    throw new Error("Subagent purge requires at least one selector.");
  }
  return input;
}

async function runSubagentPurgeCommand(options: SubagentPurgeCliOptions): Promise<void> {
  const input = buildPurgeInput(options);
  return withPostgresPool(options.dbUrl, async (pool) => {
    const agentStore = new PostgresAgentStore({pool});
    const identityStore = new PostgresIdentityStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const threadStore = new PostgresThreadRuntimeStore({pool});
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    const a2a = new A2ASessionBindingRepo({pool});
    const outbound = new PostgresOutboundDeliveryStore({pool});
    const requests = new RuntimeRequestRepo({pool});
    if (input.execute) {
      await ensureSchemas([
        identityStore,
        agentStore,
        sessionStore,
        threadStore,
        environmentStore,
        a2a,
        outbound,
        requests,
      ]);
    }

    const service = new SubagentPurgeService({
      pool,
      environmentStore,
      manager: createExecutionEnvironmentManagerClientFromEnv(process.env),
      env: process.env,
    });
    const plan = await service.purge(input);
    process.stdout.write(renderPurgePlan(plan));
  });
}

interface SubagentProfilesCliOptions {
  agent?: string;
  dbUrl?: string;
  includeDisabled?: boolean;
  showPrompt?: boolean;
  json?: boolean;
  description?: string;
  toolGroups?: string;
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
  model?: string;
  thinking?: "low" | "medium" | "high" | "xhigh";
  enable?: boolean;
  disable?: boolean;
}

function parseToolGroupsCsv(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requireAgentOption(options: SubagentProfilesCliOptions): string {
  if (!options.agent) {
    throw new Error("Subagent profile command requires --agent <agentKey>.");
  }
  return options.agent;
}

async function readPromptInput(options: SubagentProfilesCliOptions): Promise<string> {
  const sources = [
    options.prompt !== undefined,
    options.promptFile !== undefined,
    options.stdin === true,
  ].filter(Boolean).length;
  if (sources !== 1) {
    throw new Error("Use exactly one of --prompt, --prompt-file, or --stdin.");
  }
  if (options.prompt !== undefined) {
    return options.prompt;
  }
  if (options.promptFile !== undefined) {
    return readFile(options.promptFile, "utf8");
  }

  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.once("end", () => resolve(data));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
}

function renderProfile(profile: SubagentProfileRecord, options: {showPrompt?: boolean} = {}): Record<string, unknown> {
  return {
    slug: profile.slug,
    source: profile.source,
    agentKey: profile.agentKey ?? null,
    description: profile.description,
    toolGroups: profile.toolGroups,
    model: profile.model ?? null,
    thinking: profile.thinking ?? null,
    enabled: profile.enabled,
    ...(options.showPrompt ? {prompt: profile.prompt} : {}),
  };
}

function writeProfileOutput(value: unknown, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const profiles = Array.isArray(value) ? value : [value];
  for (const entry of profiles as Array<Record<string, unknown>>) {
    process.stdout.write([
      `${entry.slug} (${entry.source})`,
      `agent: ${entry.agentKey ?? "global"}`,
      `enabled: ${entry.enabled}`,
      `description: ${entry.description}`,
      `toolGroups: ${Array.isArray(entry.toolGroups) ? entry.toolGroups.join(", ") : ""}`,
      entry.model ? `model: ${entry.model}` : "",
      entry.thinking ? `thinking: ${entry.thinking}` : "",
      typeof entry.prompt === "string" ? `prompt:\n${entry.prompt}` : "",
      "",
    ].filter((line) => line !== "").join("\n"));
  }
}

async function withSubagentProfileStore<T>(
  dbUrl: string | undefined,
  run: (store: PostgresSubagentProfileStore) => Promise<T>,
): Promise<T> {
  return withPostgresPool(dbUrl, async (pool) => {
    const store = new PostgresSubagentProfileStore({pool});
    await ensureSchemas([store]);
    return run(store);
  });
}

async function runProfilesListCommand(options: SubagentProfilesCliOptions): Promise<void> {
  const agentKey = requireAgentOption(options);
  await withSubagentProfileStore(options.dbUrl, async (store) => {
    const profiles = await store.listProfiles({
      agentKey,
      includeDisabled: options.includeDisabled === true,
    });
    writeProfileOutput(profiles.map((profile) => renderProfile(profile)), options.json);
  });
}

async function runProfilesGetCommand(slug: string, options: SubagentProfilesCliOptions): Promise<void> {
  const agentKey = requireAgentOption(options);
  await withSubagentProfileStore(options.dbUrl, async (store) => {
    const profile = await store.getProfile({
      slug,
      agentKey,
      includeDisabled: options.includeDisabled === true,
    });
    if (!profile) {
      throw new Error(`Subagent profile ${slug} was not found.`);
    }
    writeProfileOutput(renderProfile(profile, {showPrompt: options.showPrompt === true}), options.json);
  });
}

async function runProfilesUpsertCommand(slug: string, options: SubagentProfilesCliOptions): Promise<void> {
  const agentKey = requireAgentOption(options);
  if (options.enable && options.disable) {
    throw new Error("Use either --enable or --disable, not both.");
  }
  if (!options.description) {
    throw new Error("Subagent profile upsert requires --description.");
  }
  const toolGroups = parseToolGroupsCsv(options.toolGroups);
  if (toolGroups.length === 0) {
    throw new Error("Subagent profile upsert requires --tool-groups.");
  }
  const model = options.model ? resolveModelSelector(options.model).canonical : undefined;
  const prompt = await readPromptInput(options);
  await withSubagentProfileStore(options.dbUrl, async (store) => {
    const profile = await store.upsertProfile({
      slug,
      agentKey,
      createdByAgentKey: agentKey,
      source: "custom",
      description: options.description ?? "",
      prompt,
      toolGroups,
      model,
      thinking: options.thinking,
      transcriptMode: "none",
      enabled: options.disable ? false : true,
    });
    writeProfileOutput(renderProfile(profile), options.json);
  });
}

async function runProfilesDisableCommand(slug: string, options: SubagentProfilesCliOptions): Promise<void> {
  const agentKey = requireAgentOption(options);
  await withSubagentProfileStore(options.dbUrl, async (store) => {
    const profile = await store.setProfileEnabled({
      slug,
      agentKey,
      enabled: false,
    });
    writeProfileOutput(renderProfile(profile), options.json);
  });
}

function registerProfileCommands(subagents: Command): void {
  const profiles = subagents
    .command("profiles")
    .description("Manage custom subagent profiles");

  profiles
    .command("list")
    .description("List visible subagent profiles")
    .requiredOption("--agent <agentKey>", "Agent key", parseAgentKey)
    .option("--include-disabled", "Include disabled profiles")
    .option("--json", "Render JSON")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (options: SubagentProfilesCliOptions, command: Command) => {
      try {
        await runProfilesListCommand(options);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });

  profiles
    .command("get")
    .description("Get a subagent profile")
    .argument("<slug>")
    .requiredOption("--agent <agentKey>", "Agent key", parseAgentKey)
    .option("--include-disabled", "Allow disabled profiles")
    .option("--show-prompt", "Include the profile prompt")
    .option("--json", "Render JSON")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (slug: string, options: SubagentProfilesCliOptions, command: Command) => {
      try {
        await runProfilesGetCommand(slug, options);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });

  profiles
    .command("upsert")
    .description("Create or update a custom agent-scoped subagent profile")
    .argument("<slug>")
    .requiredOption("--agent <agentKey>", "Agent key", parseAgentKey)
    .requiredOption("--description <text>", "Profile description")
    .requiredOption("--tool-groups <csv>", "Comma-separated subagent tool groups")
    .option("--prompt <text>", "Profile prompt text")
    .option("--prompt-file <path>", "Read profile prompt from a file")
    .option("--stdin", "Read profile prompt from stdin")
    .option("--model <selector>", "Model selector")
    .option("--thinking <level>", "Thinking level: low, medium, high, xhigh")
    .option("--enable", "Enable the profile")
    .option("--disable", "Disable the profile")
    .option("--json", "Render JSON")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (slug: string, options: SubagentProfilesCliOptions, command: Command) => {
      try {
        await runProfilesUpsertCommand(slug, options);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });

  profiles
    .command("disable")
    .description("Disable a custom agent-scoped subagent profile")
    .argument("<slug>")
    .requiredOption("--agent <agentKey>", "Agent key", parseAgentKey)
    .option("--json", "Render JSON")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (slug: string, options: SubagentProfilesCliOptions, command: Command) => {
      try {
        await runProfilesDisableCommand(slug, options);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });
}

export function registerSubagentCommands(program: Command): void {
  const subagents = program
    .command("subagents")
    .description("Manage subagent sessions and environments");

  registerProfileCommands(subagents);

  subagents
    .command("purge")
    .description("Hard purge disposable subagent sessions and environment roots")
    .option("--dry-run", "Print purge candidates without deleting anything")
    .option("--execute", "Actually stop containers, delete env files, and delete DB rows")
    .option("--agent <agentKey>", "Filter by agent key", parseAgentKey)
    .option("--session-id <id>", "Purge one subagent session", parseSessionIdOption)
    .option("--environment-id <id>", "Purge one subagent environment", (value) => parseRequiredOptionValue(value, "Environment id"))
    .option("--stopped", "Select stopped or failed disposable subagent environments")
    .option("--expired", "Select expired disposable subagent environments")
    .option("--older-than <duration>", "Select subagents whose environment was updated before this age, e.g. 7d", parseDurationOption)
    .option("--force", "Allow purging active ready subagent environments")
    .option("--skip-files", "Do not validate or delete environment filesystem roots")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (options: SubagentPurgeCliOptions, command: Command) => {
      try {
        await runSubagentPurgeCommand(options);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });
}
