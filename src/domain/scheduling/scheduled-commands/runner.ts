import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {DrainLoop} from "../../../lib/drain-loop.js";
import type {JsonObject} from "../../../lib/json.js";
import {truncateText} from "../../../lib/strings.js";
import {renderScheduledCommandEventPrompt} from "../../../prompts/runtime/scheduled-commands.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";
import {computeRecurringNextFireAt} from "../tasks/schedule.js";
import type {ScheduledCommandIntegrity} from "./integrity.js";
import type {ScheduledCommandStore} from "./store.js";
import type {
  ClaimedScheduledCommand,
  ScheduledCommandExecutionResult,
  ScheduledCommandRecord,
  ScheduledCommandRunRecord,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CLAIM_TTL_MS = 60_000;
const MIN_CLAIM_TTL_MS = 9_000;
const DEFAULT_BATCH_SIZE = 25;
export const DEFAULT_SCHEDULED_COMMAND_CONCURRENCY = 2;
const SCHEDULED_COMMAND_EVENT_SOURCE = "scheduled_command_event";

type ScheduledCommandCoordinator = Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
type ScheduledCommandRunnerStore = Pick<
  ScheduledCommandStore,
  | "claimRun"
  | "completeNotification"
  | "listDueCommands"
  | "markIntegrityViolation"
  | "materializeScheduledRun"
  | "renewRunClaim"
  | "settleRun"
  | "startRun"
>;

export interface ScheduledCommandExecutor {
  execute(input: {
    command: ScheduledCommandRecord;
    run: ScheduledCommandRunRecord;
    signal: AbortSignal;
    onPrepared(details: {environmentId: string; cwd: string}): Promise<void>;
  }): Promise<ScheduledCommandExecutionResult>;
}

export class ScheduledCommandExecutionError extends Error {
  constructor(readonly failureCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScheduledCommandExecutionError";
  }
}

export interface ScheduledCommandRunnerOptions {
  commands: ScheduledCommandRunnerStore;
  integrity: ScheduledCommandIntegrity;
  executor: ScheduledCommandExecutor;
  coordinator: ScheduledCommandCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  maxConcurrentRuns?: number;
  onError?: (error: unknown, commandId?: string) => Promise<void> | void;
}

class ScheduledCommandClaimLostError extends Error {
  constructor(runId: string, options?: ErrorOptions) {
    super(`Scheduled command run ${runId} lost its claim.`, options);
    this.name = "ScheduledCommandClaimLostError";
  }
}

function failureDetails(error: unknown): {failureCode: string; message: string} {
  if (error instanceof ScheduledCommandExecutionError) {
    return {failureCode: error.failureCode, message: truncateText(error.message, 1_000)};
  }
  return {
    failureCode: "runtime_error",
    message: truncateText(error instanceof Error ? error.message : String(error), 1_000),
  };
}

function safeFailureCode(value: string | undefined): string | undefined {
  return value && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function eventMetadata(claim: ClaimedScheduledCommand): JsonObject {
  const failureCode = safeFailureCode(claim.run.failureCode);
  return {
    scheduledCommand: {
      commandId: claim.command.commandId,
      runId: claim.run.id,
      version: claim.run.version,
      notificationKind: claim.run.notificationKind ?? "failure",
      ...(failureCode ? {failureCode} : {}),
    },
  };
}

export class ScheduledCommandRunner {
  private readonly commands: ScheduledCommandRunnerStore;
  private readonly integrity: ScheduledCommandIntegrity;
  private readonly executor: ScheduledCommandExecutor;
  private readonly coordinator: ScheduledCommandCoordinator;
  private readonly claimTtlMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly onError?: ScheduledCommandRunnerOptions["onError"];
  private readonly activeClaims = new Set<Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly drainLoop: DrainLoop;
  private readonly claimOwner = "scheduled-command-runner";

  constructor(options: ScheduledCommandRunnerOptions) {
    this.commands = options.commands;
    this.integrity = options.integrity;
    this.executor = options.executor;
    this.coordinator = options.coordinator;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (!Number.isFinite(this.claimTtlMs) || this.claimTtlMs < MIN_CLAIM_TTL_MS) {
      throw new Error(`Scheduled command claim TTL must be at least ${MIN_CLAIM_TTL_MS}ms.`);
    }
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_SCHEDULED_COMMAND_CONCURRENCY;
    if (!Number.isInteger(this.maxConcurrentRuns) || this.maxConcurrentRuns <= 0) {
      throw new Error("Scheduled command concurrency must be a positive integer.");
    }
    this.onError = options.onError;
    this.drainLoop = new DrainLoop({
      label: "Scheduled command runner drain",
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      drain: () => this.drain(),
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  async start(): Promise<void> {
    this.drainLoop.start();
  }

  async stop(): Promise<void> {
    for (const controller of this.activeControllers.values()) {
      controller.abort(new Error("Scheduled command runner stopped."));
    }
    await this.drainLoop.stop();
    await Promise.allSettled([...this.activeClaims]);
  }

  async triggerDrain(): Promise<void> {
    await this.drainLoop.trigger();
  }

  private async drain(): Promise<void> {
    while (!this.drainLoop.isStopped) {
      while (!this.drainLoop.isStopped && this.activeClaims.size < this.maxConcurrentRuns) {
        const claim = await this.commands.claimRun({claimedBy: this.claimOwner, claimTtlMs: this.claimTtlMs});
        if (!claim) break;
        this.supervise(claim);
      }
      if (this.activeClaims.size >= this.maxConcurrentRuns) return;
      const due = await this.commands.listDueCommands({
        limit: Math.min(DEFAULT_BATCH_SIZE, this.maxConcurrentRuns - this.activeClaims.size),
      });
      if (due.length === 0) return;
      let materialized = false;
      for (const command of due) {
        if (command.nextFireAt === undefined) continue;
        const run = await this.commands.materializeScheduledRun({
          commandId: command.commandId,
          scheduledFor: command.nextFireAt,
          // Coalesce downtime into this occurrence and resume at the first
          // future fire instead of replaying an unbounded backlog.
          nextFireAt: computeRecurringNextFireAt(
            {kind: "recurring", cron: command.cron, timezone: command.timezone},
            Date.now(),
          ),
        });
        materialized ||= run !== null;
      }
      if (!materialized) return;
    }
  }

  private supervise(claim: ClaimedScheduledCommand): void {
    let promise!: Promise<void>;
    promise = this.processWithRenewal(claim)
      .catch(async (error) => {
        try {
          await this.onError?.(error, claim.command.commandId);
        } catch (reportError) {
          console.error("Scheduled command error handler failed", {
            commandId: claim.command.commandId,
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      })
      .finally(() => {
        this.activeClaims.delete(promise);
        this.activeControllers.delete(claim.run.id);
        if (!this.drainLoop.isStopped) this.drainLoop.kick();
      });
    this.activeClaims.add(promise);
  }

  private async processWithRenewal(claim: ClaimedScheduledCommand): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(claim.run.id, controller);
    let renewal = Promise.resolve();
    let lost = false;
    let rejectLoss!: (error: unknown) => void;
    const claimLoss = new Promise<never>((_resolve, reject) => { rejectLoss = reject; });
    const interval = setInterval(() => {
      renewal = renewal.then(async () => {
        try {
          const renewed = await this.commands.renewRunClaim({
            runId: claim.run.id,
            claimToken: claim.run.claimToken,
            claimTtlMs: this.claimTtlMs,
          });
          if (!renewed) throw new ScheduledCommandClaimLostError(claim.run.id);
        } catch (error) {
          if (!lost) {
            lost = true;
            controller.abort(error);
            rejectLoss(error instanceof ScheduledCommandClaimLostError
              ? error
              : new ScheduledCommandClaimLostError(claim.run.id, {cause: error}));
          }
        }
      });
    }, Math.max(3_000, Math.floor(this.claimTtlMs / 3)));
    interval.unref?.();

    try {
      await Promise.race([this.processClaim(claim, controller.signal), claimLoss]);
    } finally {
      clearInterval(interval);
      await renewal;
    }
  }

  private async processClaim(claim: ClaimedScheduledCommand, signal: AbortSignal): Promise<void> {
    if (claim.run.notificationKind && claim.run.notifiedAt === undefined
      && (claim.run.status === "failed" || claim.run.status === "succeeded")) {
      await this.deliverNotification(claim);
      return;
    }

    if (!this.integrity.verify(claim.command)) {
      claim = {
        ...claim,
        run: await this.commands.markIntegrityViolation({
          runId: claim.run.id,
          claimToken: claim.run.claimToken,
          reason: "The stored scheduled command definition failed its HMAC integrity check.",
        }) as ClaimedScheduledCommand["run"],
      };
      await this.deliverNotification(claim);
      return;
    }

    let settled: ScheduledCommandRunRecord | undefined;
    let result: ScheduledCommandExecutionResult | undefined;
    try {
      result = await this.executor.execute({
        command: claim.command,
        run: claim.run,
        signal,
        onPrepared: async ({environmentId, cwd}) => {
          await this.commands.startRun({
            runId: claim.run.id,
            claimToken: claim.run.claimToken,
            environmentId,
            cwd,
          });
        },
      });
    } catch (error) {
      if (error instanceof ScheduledCommandClaimLostError || signal.aborted) throw error;
      const failure = failureDetails(error);
      settled = await this.commands.settleRun({
        runId: claim.run.id,
        claimToken: claim.run.claimToken,
        status: "failed",
        failureCode: failure.failureCode,
        error: failure.message,
      });
    }
    if (result) {
      const succeeded = !result.timedOut && result.exitCode === 0;
      settled = await this.commands.settleRun({
        runId: claim.run.id,
        claimToken: claim.run.claimToken,
        status: succeeded ? "succeeded" : "failed",
        result,
        ...(succeeded ? {} : {
          failureCode: result.timedOut ? "timeout" : "nonzero_exit",
          error: result.timedOut
            ? `Scheduled command exceeded its ${claim.command.timeoutMs}ms timeout.`
            : `Scheduled command exited with code ${result.exitCode ?? "unknown"}.`,
        }),
      });
    }
    if (!settled) {
      throw new Error(`Scheduled command run ${claim.run.id} produced no settlement.`);
    }
    if (settled.notificationKind) {
      await this.deliverNotification({...claim, run: {...settled, claimToken: claim.run.claimToken,
        claimedAt: claim.run.claimedAt, claimedBy: claim.run.claimedBy, claimExpiresAt: claim.run.claimExpiresAt}});
    }
  }

  private async deliverNotification(claim: ClaimedScheduledCommand): Promise<void> {
    const kind = claim.run.notificationKind ?? "failure";
    await this.coordinator.submitSessionInput(claim.command.sessionId, {
      message: stringToUserMessage(renderScheduledCommandEventPrompt({
        commandId: claim.command.commandId,
        runId: claim.run.id,
        kind,
        failureCode: safeFailureCode(claim.run.failureCode),
      })),
      source: SCHEDULED_COMMAND_EVENT_SOURCE,
      externalMessageId: claim.run.id,
      identityId: claim.command.createdByIdentityId,
      metadata: eventMetadata(claim),
    }, "wake", {inputId: claim.run.id});
    await this.commands.completeNotification({runId: claim.run.id, claimToken: claim.run.claimToken});
  }
}
