import {randomUUID} from "node:crypto";
import process from "node:process";
import {createInterface} from "node:readline/promises";

import type {Writable} from "node:stream";

import type {ToolResultMessage} from "@mariozechner/pi-ai";

import type {ThreadMessageRecord, ThreadRecord} from "../../domain/threads/runtime/index.js";
import {formatToolCallFallback, formatToolResultFallback, type JsonValue,} from "../../kernel/agent/index.js";
import {createPandaClient} from "../runtime/client.js";
import {createPandaDaemon} from "../runtime/daemon.js";
import {waitForSmokeDaemonOnline, waitForSmokeThreadIdle} from "./harness.js";

export interface SmokeFollowUpOptions {
  artifactDir: string;
  cwd?: string;
  dbUrl: string;
  identity?: string;
  input?: NodeJS.ReadableStream;
  output?: Writable;
  sessionId?: string;
  threadId?: string;
  timeoutMs: number;
}

function isTtyStream(stream: NodeJS.ReadableStream | Writable): stream is (NodeJS.ReadableStream | Writable) & {isTTY: true} {
  return "isTTY" in stream && stream.isTTY === true;
}

function writeLine(output: Writable, text = ""): void {
  output.write(`${text}\n`);
}

function trimCommand(line: string): string {
  return line.trim().toLowerCase();
}

function renderAssistantEntry(entry: ThreadMessageRecord): string[] {
  if (entry.message.role !== "assistant") {
    return [];
  }

  const lines: string[] = [];
  let bufferedText = "";

  const flushText = (): void => {
    const text = bufferedText.trim();
    if (!text) {
      return;
    }

    lines.push(`assistant> ${text}`);
    bufferedText = "";
  };

  for (const block of entry.message.content) {
    if (block.type === "text" && block.text.trim()) {
      bufferedText += (bufferedText ? "\n" : "") + block.text.trim();
      continue;
    }

    if (block.type === "toolCall") {
      flushText();
      lines.push(`[tool call] ${block.name}`);
      lines.push(formatToolCallFallback(block.arguments ?? {}));
    }
  }

  flushText();
  return lines;
}

function renderToolResultEntry(entry: ThreadMessageRecord): string[] {
  if (entry.message.role !== "toolResult") {
    return [];
  }

  const resultText = formatToolResultFallback(entry.message as ToolResultMessage<JsonValue>);
  const title = entry.message.isError
    ? `[tool error] ${entry.message.toolName}`
    : `[tool result] ${entry.message.toolName}`;

  return [title, resultText];
}

function renderFollowUpEntries(entries: readonly ThreadMessageRecord[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.origin !== "runtime") {
      return [];
    }

    if (entry.message.role === "assistant") {
      return renderAssistantEntry(entry);
    }

    if (entry.message.role === "toolResult") {
      return renderToolResultEntry(entry);
    }

    return [];
  });
}

function isReadlineClosedError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && (error as {code?: unknown}).code === "ERR_USE_AFTER_CLOSE";
}

async function openFollowUpThread(input: {
  client: Awaited<ReturnType<typeof createPandaClient>>;
  sessionId?: string;
  threadId?: string;
}): Promise<ThreadRecord> {
  if (input.sessionId) {
    return input.client.openSession(input.sessionId);
  }

  if (input.threadId) {
    return input.client.getThread(input.threadId);
  }

  throw new Error("Interactive smoke follow-up requires a session or thread id.");
}

export async function startSmokeFollowUpRepl(options: SmokeFollowUpOptions): Promise<void> {
  let daemon: Awaited<ReturnType<typeof createPandaDaemon>> | null = null;
  let daemonError: Error | null = null;
  let daemonRunPromise: Promise<void> | null = null;
  let client: Awaited<ReturnType<typeof createPandaClient>> | null = null;

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  try {
    daemon = await createPandaDaemon({
      cwd: options.cwd ?? process.cwd(),
      dbUrl: options.dbUrl,
    });
    daemonRunPromise = daemon.run().catch((error) => {
      daemonError = error instanceof Error ? error : new Error(String(error));
    });
    await waitForSmokeDaemonOnline({
      dbUrl: options.dbUrl,
      timeoutMs: Math.min(options.timeoutMs, 15_000),
      getDaemonError: () => daemonError,
    });

    client = await createPandaClient({
      dbUrl: options.dbUrl,
      identity: options.identity,
    });

    let thread = await openFollowUpThread({
      client,
      sessionId: options.sessionId,
      threadId: options.threadId,
    });

    writeLine(output);
    writeLine(output, "Entering smoke follow-up mode.");
    writeLine(output, `session ${thread.sessionId}`);
    writeLine(output, `thread ${thread.id}`);
    writeLine(output, `artifacts ${options.artifactDir}`);
    writeLine(output, "Commands: /exit, /help, /artifacts, /where");

    const rl = createInterface({
      input,
      output,
      terminal: isTtyStream(input) && isTtyStream(output),
    });

    try {
      while (true) {
        let line: string;
        try {
          line = await rl.question("follow-up> ");
        } catch (error) {
          if (isReadlineClosedError(error)) {
            break;
          }

          throw error;
        }
        const trimmed = line.trim();
        const command = trimCommand(trimmed);

        if (!trimmed) {
          continue;
        }

        if (command === "/exit" || command === "/quit") {
          break;
        }

        if (command === "/help") {
          writeLine(output, "Commands: /exit, /help, /artifacts, /where");
          continue;
        }

        if (command === "/artifacts") {
          writeLine(output, options.artifactDir);
          continue;
        }

        if (command === "/where") {
          writeLine(output, `session ${thread.sessionId}`);
          writeLine(output, `thread ${thread.id}`);
          continue;
        }

        const transcriptBefore = await client.store.loadTranscript(thread.id);
        const lastSequence = transcriptBefore.at(-1)?.sequence ?? 0;
        const submission = await client.submitTextInput({
          actorId: client.identity.handle,
          externalMessageId: randomUUID(),
          text: trimmed,
          threadId: thread.id,
        });

        thread = await client.getThread(submission.threadId);
        await waitForSmokeThreadIdle({
          store: client.store,
          threadId: thread.id,
          timeoutMs: options.timeoutMs,
        });

        const transcriptAfter = await client.store.loadTranscript(thread.id);
        const newEntries = transcriptAfter.filter((entry) => entry.sequence > lastSequence);
        const rendered = renderFollowUpEntries(newEntries);
        if (rendered.length === 0) {
          writeLine(output, "(no new runtime output)");
          continue;
        }

        for (const renderedLine of rendered) {
          writeLine(output, renderedLine);
        }
      }
    } finally {
      rl.close();
    }
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    await daemonRunPromise?.catch(() => undefined);
  }
}
