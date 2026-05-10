import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../runtime/postgres-bootstrap.js";
import {
  summarizeWorkerPurgeCounts,
  type WorkerPurgeCandidate,
  type WorkerPurgeInput,
  type WorkerPurgePlan,
  WorkerPurgeService,
} from "../runtime/worker-purge-service.js";
import {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/postgres.js";
import {PostgresExecutionEnvironmentStore} from "../../domain/execution-environments/postgres.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import {PostgresIdentityStore} from "../../domain/identity/postgres.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import {createExecutionEnvironmentManagerClientFromEnv} from "../../integrations/shell/index.js";
import {parseAgentKey} from "../../domain/agents/cli.js";
import {parseRequiredOptionValue, parseSessionIdOption} from "../../lib/cli.js";

interface WorkerPurgeCliOptions {
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

function formatCandidate(candidate: WorkerPurgeCandidate, now: number): string {
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
    `  externalFileRefs: ${candidate.externalFileReferenceCount}`,
  ];
  if (candidate.refusedReason) {
    lines.push(`  refused: ${candidate.refusedReason}`);
  }
  return lines.join("\n");
}

function renderPurgePlan(plan: WorkerPurgePlan): string {
  const counts = summarizeWorkerPurgeCounts(plan.candidates);
  const totalBytes = plan.candidates.reduce((sum, candidate) => sum + (candidate.filesystem.bytes ?? 0), 0);
  const header = [
    plan.dryRun ? "Worker purge dry-run" : "Worker purge executed",
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

export function buildPurgeInput(options: WorkerPurgeCliOptions): WorkerPurgeInput {
  if (options.execute && options.dryRun) {
    throw new Error("Use either --dry-run or --execute, not both.");
  }
  const input: WorkerPurgeInput = {
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
    throw new Error("Worker purge requires at least one selector.");
  }
  return input;
}

async function runWorkerPurgeCommand(options: WorkerPurgeCliOptions): Promise<void> {
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

    const service = new WorkerPurgeService({
      pool,
      environmentStore,
      manager: createExecutionEnvironmentManagerClientFromEnv(process.env),
      env: process.env,
    });
    const plan = await service.purge(input);
    process.stdout.write(renderPurgePlan(plan));
  });
}

export function registerWorkerCommands(program: Command): void {
  const workers = program
    .command("workers")
    .description("Manage disposable worker sessions");

  workers
    .command("purge")
    .description("Hard purge disposable worker sessions and environment roots")
    .option("--dry-run", "Print purge candidates without deleting anything")
    .option("--execute", "Actually stop containers, delete env files, and delete DB rows")
    .option("--agent <agentKey>", "Filter by agent key", parseAgentKey)
    .option("--session-id <id>", "Purge one worker session", parseSessionIdOption)
    .option("--environment-id <id>", "Purge one worker environment", (value) => parseRequiredOptionValue(value, "Environment id"))
    .option("--stopped", "Select stopped or failed disposable worker environments")
    .option("--expired", "Select expired disposable worker environments")
    .option("--older-than <duration>", "Select workers whose environment was updated before this age, e.g. 7d", parseDurationOption)
    .option("--force", "Allow purging active ready workers")
    .option("--skip-files", "Do not validate or delete environment filesystem roots")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (options: WorkerPurgeCliOptions, command: Command) => {
      try {
        await runWorkerPurgeCommand(options);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });
}
