import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {parseAgentKey} from "../../domain/agents/cli.js";
import {parseIdentityHandle} from "../../domain/identity/cli.js";
import {requireSmokeDatabaseUrl} from "./config.js";
import {startSmokeFollowUpRepl} from "./follow-up.js";
import {runSmoke} from "./harness.js";

interface SmokeCliOptions {
  agent?: string;
  allowUnsafeDbReset?: boolean;
  artifactsDir?: string;
  dbUrl?: string;
  expectText: string[];
  expectTool: string[];
  forbidToolError?: boolean;
  identity?: string;
  input: string[];
  interactive?: boolean;
  json?: boolean;
  model?: string;
  reuseDb?: boolean;
  session?: string;
  timeoutMs?: number;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }

  return parsed;
}

function parseSessionId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidArgumentError("Session id must not be empty.");
  }

  return trimmed;
}

function renderSmokeText(result: Awaited<ReturnType<typeof runSmoke>>): string {
  if (result.success) {
    return [
      "Smoke passed.",
      `thread ${result.threadId ?? "-"}`,
      `session ${result.sessionId ?? "-"}`,
      `artifacts ${result.artifactDir}`,
    ].join("\n") + "\n";
  }

  return [
    `Smoke failed: ${result.error?.message ?? "Unknown failure."}`,
    `artifacts ${result.artifactDir}`,
  ].join("\n") + "\n";
}

export async function runSmokeCliCommand(options: SmokeCliOptions): Promise<void> {
  if (!options.agent && !options.session) {
    throw new InvalidArgumentError("Pass --agent or --session.");
  }

  if (options.session && options.reuseDb !== true) {
    throw new InvalidArgumentError("Session-targeted smoke requires --reuse-db.");
  }

  if (options.session && options.model) {
    throw new InvalidArgumentError("Session-targeted smoke does not support --model.");
  }

  const dbUrl = requireSmokeDatabaseUrl(options.dbUrl);
  const result = await runSmoke({
    agentKey: options.agent,
    allowUnsafeDbReset: options.allowUnsafeDbReset,
    artifactsDir: options.artifactsDir,
    dbUrl,
    expectText: options.expectText,
    expectTool: options.expectTool,
    forbidToolError: options.forbidToolError,
    identity: options.identity,
    inputs: options.input,
    model: options.model,
    reuseDb: options.reuseDb,
    sessionId: options.session,
    timeoutMs: options.timeoutMs,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.success) {
    process.stdout.write(renderSmokeText(result));
  } else {
    process.stderr.write(renderSmokeText(result));
  }

  if (!result.success) {
    process.exitCode = 1;
  }

  if (!options.interactive) {
    return;
  }

  if (!result.sessionId && !result.threadId) {
    process.stderr.write("Interactive follow-up is unavailable because the smoke run did not produce a session or thread.\n");
    return;
  }

  await startSmokeFollowUpRepl({
    artifactDir: result.artifactDir,
    dbUrl,
    identity: options.identity ?? result.config.identityHandle,
    sessionId: result.sessionId,
    threadId: result.threadId,
    timeoutMs: options.timeoutMs ?? result.config.timeoutMs,
  });
}

export function registerSmokeCommand(program: Command): void {
  program
    .command("smoke")
    .description("Run a headless live Panda smoke against a disposable Postgres database")
    .option("--agent <agentKey>", "Agent key to smoke", parseAgentKey)
    .option("--session <sessionId>", "Existing session id to target directly", parseSessionId)
    .option("--input <text>", "Input text to send to Panda (repeatable)", collectOption, [])
    .option("--model <selector-or-alias>", "Model selector override")
    .option("--identity <handle>", "Identity handle to use (defaults to smoke)", parseIdentityHandle)
    .option("--db-url <url>", "Postgres connection string for live smoke (or TEST_DATABASE_URL)")
    .option("--timeout-ms <ms>", "Run timeout in milliseconds", parsePositiveInt)
    .option("--expect-text <text>", "Expected transcript substring (repeatable)", collectOption, [])
    .option("--expect-tool <toolName>", "Expected tool name (repeatable)", collectOption, [])
    .option("--forbid-tool-error", "Fail if any tool result is marked as an error")
    .option("--artifacts-dir <path>", "Directory for smoke artifacts")
    .option("--interactive", "Drop into a follow-up REPL on the same persisted smoke session")
    .option("--json", "Print the full smoke result as JSON")
    .option("--reuse-db", "Reuse the existing smoke database instead of recreating it")
    .option("--allow-unsafe-db-reset", "Allow resetting a database whose name does not look disposable")
    .action((options: SmokeCliOptions) => {
      return runSmokeCliCommand(options);
    });
}
