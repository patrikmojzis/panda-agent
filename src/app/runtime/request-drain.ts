import type {RuntimeRequestRecord} from "../../domain/threads/requests/types.js";
import {DrainLoop} from "../../lib/drain-loop.js";

export const DEFAULT_RUNTIME_REQUEST_DRAIN_POLL_INTERVAL_MS = 15_000;

export interface RuntimeRequestDrainStore {
  claimNextPendingRequest(): Promise<RuntimeRequestRecord | null>;
  completeRequest(id: string, result?: unknown): Promise<unknown>;
  failRequest(id: string, error: string): Promise<unknown>;
}

interface RuntimeRequestDrainOptions {
  requests: RuntimeRequestDrainStore;
  processRequest(request: RuntimeRequestRecord): Promise<unknown>;
  label?: string;
  onError?: (error: unknown) => Promise<void> | void;
  pollIntervalMs?: number;
}

/**
 * Drains runtime requests behind the lifecycle seam and waits for active work on stop.
 */
export class RuntimeRequestDrain {
  private readonly requests: RuntimeRequestDrainStore;
  private readonly processRequest: (request: RuntimeRequestRecord) => Promise<unknown>;
  private readonly loop: DrainLoop;

  constructor(options: RuntimeRequestDrainOptions) {
    this.requests = options.requests;
    this.processRequest = options.processRequest;
    this.loop = new DrainLoop({
      label: options.label ?? "runtime request drain",
      drain: () => this.drain(),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RUNTIME_REQUEST_DRAIN_POLL_INTERVAL_MS,
      onError: options.onError,
    });
  }

  start(): void {
    this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  async trigger(): Promise<void> {
    await this.loop.trigger();
  }

  kick(): void {
    this.loop.kick();
  }

  private async drain(): Promise<void> {
    while (!this.loop.isStopped) {
      const request = await this.requests.claimNextPendingRequest();
      if (!request) {
        return;
      }

      await this.processClaimedRequest(request);
    }
  }

  private async processClaimedRequest(request: RuntimeRequestRecord): Promise<void> {
    try {
      const result = await this.processRequest(request);
      await this.requests.completeRequest(request.id, result);
    } catch (error) {
      await this.requests.failRequest(request.id, error instanceof Error ? error.message : String(error));
    }
  }
}
