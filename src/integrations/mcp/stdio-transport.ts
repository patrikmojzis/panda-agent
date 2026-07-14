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
  private readonly stderrStream = new PassThrough();
  private pending = Buffer.alloc(0);
  private overflowed = false;

  constructor(private readonly options: BoundedStdioTransportOptions) {}

  get stderr(): Stream {
    return this.stderrStream;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("Bounded stdio transport already started.");
    if (this.options.signal.aborted) throw this.options.signal.reason;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: {...getDefaultEnvironment(), ...(this.options.env ?? {})},
        shell: false,
        windowsHide: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      const onAbort = () => this.kill("SIGKILL");
      this.options.signal.addEventListener("abort", onAbort, {once: true});
      child.once("spawn", resolve);
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("close", () => {
        this.options.signal.removeEventListener("abort", onAbort);
        this.process = undefined;
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
        this.onerror?.(error);
        this.kill("SIGKILL");
        return;
      }
      if (segment.length > 0) this.pending = Buffer.concat([this.pending, segment]);
      if (newline === -1) return;
      const line = this.pending;
      this.pending = Buffer.alloc(0);
      try {
        const text = line.toString("utf8").replace(/\r$/, "");
        this.onmessage?.(deserializeMessage(text));
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

  async close(): Promise<void> {
    const child = this.process;
    this.pending = Buffer.alloc(0);
    if (!child) return;
    this.process = undefined;
    if (this.options.signal.aborted || Date.now() >= this.options.deadlineAt) {
      child.kill("SIGKILL");
      return;
    }
    child.stdin.end();
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const remaining = Math.max(0, this.options.deadlineAt - Date.now());
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)).unref())]);
    if (child.exitCode === null) child.kill("SIGTERM");
    const afterTerm = Math.max(0, this.options.deadlineAt - Date.now());
    if (afterTerm > 0) {
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, afterTerm)).unref())]);
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.process?.kill(signal);
    } catch {
      // Best-effort cleanup only.
    }
  }
}
