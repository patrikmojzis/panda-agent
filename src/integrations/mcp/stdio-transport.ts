import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {PassThrough, type Stream} from "node:stream";

import {getDefaultEnvironment} from "@modelcontextprotocol/sdk/client/stdio.js";
import {deserializeMessage, serializeMessage} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {Transport} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {JSONRPCMessage} from "@modelcontextprotocol/sdk/types.js";

export class McpStdioIngressLimitError extends Error {
  constructor() {
    super("MCP stdio JSON-RPC line exceeded the configured byte limit.");
    this.name = "McpStdioIngressLimitError";
  }
}

export interface BoundedStdioTransportOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  maxLineBytes: number;
  deadlineAt: number;
  signal: AbortSignal;
}

export class BoundedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process?: ChildProcessWithoutNullStreams;
  private started = false;
  private closeRequested = false;
  private processGroupId?: number;
  private termination?: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly stderrStream = new PassThrough();
  private pending = Buffer.alloc(0);
  private overflowed = false;
  private receivedMessage = false;

  constructor(private readonly options: BoundedStdioTransportOptions) {}

  get stderr(): Stream {
    return this.stderrStream;
  }

  get protocolMessageReceived(): boolean {
    return this.receivedMessage;
  }

  get ingressLimitExceeded(): boolean {
    return this.overflowed;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Bounded stdio transport already started.");
    if (this.closeRequested) throw new Error("Bounded stdio transport already closed.");
    if (this.options.signal.aborted) throw this.options.signal.reason;
    this.started = true;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: {...getDefaultEnvironment(), ...(this.options.env ?? {})},
        shell: false,
        windowsHide: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.process = child;
      if (process.platform !== "win32" && child.pid !== undefined && child.pid > 0) {
        this.processGroupId = child.pid;
      }
      const onAbort = () => void this.terminate(child, false);
      this.options.signal.addEventListener("abort", onAbort, {once: true});
      child.once("exit", () => void this.terminate(child, true));
      child.once("spawn", resolve);
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("close", () => {
        this.options.signal.removeEventListener("abort", onAbort);
        if (this.process === child) this.process = undefined;
        void this.terminate(child, true);
        this.onclose?.();
      });
      child.stdin.on("error", (error) => this.onerror?.(error));
      child.stdout.on("error", (error) => this.onerror?.(error));
      child.stdout.on("data", (chunk: Buffer) => this.acceptChunk(chunk));
      child.stderr.pipe(this.stderrStream, {end: false});
    });
  }

  private acceptChunk(chunk: Buffer): void {
    if (this.overflowed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.pending.length + segment.length > this.options.maxLineBytes) {
        this.overflowed = true;
        this.pending = Buffer.alloc(0);
        const error = new McpStdioIngressLimitError();
        void this.terminate(this.process, false);
        this.onerror?.(error);
        return;
      }
      if (segment.length > 0) this.pending = Buffer.concat([this.pending, segment]);
      if (newline === -1) return;
      const line = this.pending;
      this.pending = Buffer.alloc(0);
      try {
        const text = line.toString("utf8").replace(/\r$/, "");
        const message = deserializeMessage(text);
        this.receivedMessage = true;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
      offset = newline + 1;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin) throw new Error("MCP stdio transport is not connected.");
    const serialized = serializeMessage(message);
    if (stdin.write(serialized)) return;
    await new Promise<void>((resolve, reject) => {
      stdin.once("drain", resolve);
      stdin.once("error", reject);
    });
  }

  close(): Promise<void> {
    this.closeRequested = true;
    if (!this.closePromise) {
      let resolveClose!: () => void;
      let rejectClose!: (reason?: unknown) => void;
      this.closePromise = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      void this.closeOnce().then(resolveClose, rejectClose);
    }
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    const child = this.process;
    this.pending = Buffer.alloc(0);
    if (!child) {
      await this.termination;
      return;
    }
    this.process = undefined;
    if (process.platform !== "win32") {
      await this.terminate(child, false);
      return;
    }
    if (this.options.signal.aborted || Date.now() >= this.options.deadlineAt) {
      await this.terminate(child, false);
      return;
    }
    child.stdin.end();
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const remaining = Math.max(0, this.options.deadlineAt - Date.now());
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)).unref())]);
    await this.terminate(child, true);
  }

  private terminate(child: ChildProcessWithoutNullStreams | undefined, graceful: boolean): Promise<void> {
    if (process.platform !== "win32") {
      this.killProcessGroup();
      return Promise.resolve();
    }
    if (!graceful) {
      this.signalChild(child, "SIGKILL");
      return Promise.resolve();
    }

    this.termination ??= this.terminateWindowsGracefully(child);
    return this.termination;
  }

  private async terminateWindowsGracefully(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
    const termSent = this.signalChild(child, "SIGTERM");
    const afterTerm = Math.max(0, this.options.deadlineAt - Date.now());
    if (termSent && afterTerm > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, afterTerm)));
    }
    this.signalChild(child, "SIGKILL");
  }

  private killProcessGroup(): void {
    const processGroupId = this.processGroupId;
    if (processGroupId === undefined) return;
    this.processGroupId = undefined;
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The group has already exited or cannot be signaled.
    }
  }

  private signalChild(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals): boolean {
    const pid = child?.pid;
    if (!child || pid === undefined || pid <= 0
      || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }

    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}
