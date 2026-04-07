import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

import {
  hasAnthropicOauthToken,
  hasOpenAICodexOauthToken,
  resolveProviderApiKey,
  Thread,
  stringToUserMessage,
  type InputItem,
} from "../agent-core/index.js";
import { createPandaAgent } from "../panda/agent.js";
import { createDefaultPandaContexts } from "../panda/contexts/index.js";
import type { PandaProviderName, PandaSessionContext } from "../panda/types.js";
import { stripAnsi, theme } from "./theme.js";

const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

type EntryRole = "assistant" | "user" | "tool" | "meta" | "error";

interface TranscriptEntry {
  role: EntryRole;
  title: string;
  body: string;
}

export interface ChatCliOptions {
  provider?: PandaProviderName;
  model?: string;
  cwd?: string;
  instructions?: string;
}

function parseProvider(value: string): PandaProviderName | null {
  return value === "openai" ||
    value === "openai-codex" ||
    value === "anthropic" ||
    value === "anthropic-oauth"
    ? value
    : null;
}

function defaultProvider(): PandaProviderName {
  const configured = process.env.PANDA_PROVIDER;
  const parsed = configured ? parseProvider(configured) : null;
  if (parsed) {
    return parsed;
  }

  if (hasAnthropicOauthToken() && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return "anthropic-oauth";
  }

  if (hasOpenAICodexOauthToken() && !process.env.OPENAI_API_KEY) {
    return "openai-codex";
  }

  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return "anthropic";
  }

  return "openai";
}

function defaultModel(provider: PandaProviderName): string {
  if (process.env.PANDA_MODEL) {
    return process.env.PANDA_MODEL;
  }

  if (provider === "openai-codex") {
    return process.env.OPENAI_CODEX_MODEL ?? "gpt-5.4";
  }

  if (provider === "anthropic" || provider === "anthropic-oauth") {
    return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  }

  return process.env.OPENAI_MODEL ?? "gpt-5.1";
}

function missingApiKeyMessage(provider: PandaProviderName): string | null {
  if (provider === "openai-codex") {
    return hasOpenAICodexOauthToken()
      ? null
      : "Missing OpenAI Codex OAuth token. Run `codex login` with file-based credential storage, copy `~/.codex/auth.json`, or set OPENAI_OAUTH_TOKEN before sending OpenAI Codex requests.";
  }

  if (provider === "anthropic-oauth") {
    return hasAnthropicOauthToken()
      ? null
      : "Missing Anthropic OAuth token. Add ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN before sending Anthropic OAuth requests.";
  }

  if (provider === "anthropic") {
    return resolveProviderApiKey(provider)
      ? null
      : "Missing ANTHROPIC_API_KEY. You can also provide ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.";
  }

  return resolveProviderApiKey(provider)
    ? null
    : "Missing OPENAI_API_KEY. Add it to your environment before sending OpenAI requests.";
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const source = text.length === 0 ? [""] : text.split("\n");
  const lines: string[] = [];

  for (const line of source) {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
        continue;
      }

      if ((current + " " + word).length <= width) {
        current += ` ${word}`;
        continue;
      }

      lines.push(current);
      current = word;
    }

    if (current.length > 0) {
      lines.push(current);
    }
  }

  return lines;
}

function box(lines: string[], width: number): string[] {
  const innerWidth = Math.max(10, width - 2);
  const normalized = lines.flatMap((line) => wrapText(line, innerWidth));

  return [
    `┌${"─".repeat(innerWidth)}┐`,
    ...normalized.map((line) => `│${padAnsiEnd(line, innerWidth)}│`),
    `└${"─".repeat(innerWidth)}┘`,
  ];
}

function padAnsiEnd(value: string, width: number): string {
  const visibleLength = stripAnsi(value).length;
  if (visibleLength >= width) {
    return value;
  }

  return value + " ".repeat(width - visibleLength);
}

function parseToolOutput(raw: string): string {
  const isError = raw.startsWith("[Error] ");
  const payload = isError ? raw.slice("[Error] ".length) : raw;

  try {
    const parsed = JSON.parse(payload) as { output?: Record<string, unknown> | null };
    const outputPayload = parsed.output;

    if (!outputPayload || typeof outputPayload !== "object") {
      return raw;
    }

    const stdout = typeof outputPayload.stdout === "string" ? outputPayload.stdout.trim() : "";
    const stderr = typeof outputPayload.stderr === "string" ? outputPayload.stderr.trim() : "";
    const exitCode =
      typeof outputPayload.exitCode === "number" ? outputPayload.exitCode : "unknown";
    const timedOut = outputPayload.timedOut === true ? "timed out" : `exit ${String(exitCode)}`;
    const shellSummary = [stdout, stderr].filter(Boolean).join("\n\n");
    const summary = shellSummary || "Command completed with no output.";

    return `${timedOut}\n${summary}`;
  } catch {
    return raw;
  }
}

function parseToolCall(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (typeof parsed.command === "string") {
      return parsed.command;
    }

    return JSON.stringify(parsed);
  } catch {
    return args;
  }
}

class PandaChatApp {
  private providerName: PandaProviderName;
  private model: string;
  private readonly cwd: string;
  private readonly instructions?: string;
  private readonly locale: string;
  private readonly timezone: string;
  private readonly rl: readline.Interface;
  private readonly transcript: TranscriptEntry[] = [];
  private status = "";
  private thread: Thread<PandaSessionContext>;

  constructor(options: ChatCliOptions = {}) {
    this.providerName = options.provider ?? defaultProvider();
    this.model = options.model ?? defaultModel(this.providerName);
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.instructions = options.instructions;
    this.locale = Intl.DateTimeFormat().resolvedOptions().locale;
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    this.thread = this.buildThread();
    this.rl = readline.createInterface({ input, output, terminal: true });
  }

  async run(): Promise<void> {
    this.enterScreen();
    this.pushEntry(
      "meta",
      "welcome",
      "Chat with Panda in this terminal. Commands: /help, /provider <openai|openai-codex|anthropic|anthropic-oauth>, /model <name>, /new, /clear, /exit.",
    );

    try {
      let running = true;
      while (running) {
        this.render();
        const prompt = theme.bold(theme.coral("you")) + theme.slate(" > ");
        const message = (await this.rl.question(prompt)).trim();

        if (!message) {
          continue;
        }

        running = await this.handleInput(message);
      }
    } finally {
      this.rl.close();
      this.exitScreen();
    }
  }

  private buildThread(history: InputItem[] = this.thread?.input ?? []): Thread<PandaSessionContext> {
    return new Thread({
      agent: createPandaAgent({
        promptAdditions: this.instructions,
        model: this.model,
      }),
      input: [...history],
      providerName: this.providerName,
      context: {
        cwd: this.cwd,
        locale: this.locale,
        timezone: this.timezone,
      },
      llmContexts: createDefaultPandaContexts({
        locale: this.locale,
        timeZone: this.timezone,
      }),
    });
  }

  private pushEntry(role: EntryRole, title: string, body: string): void {
    this.transcript.push({ role, title, body });
  }

  private async handleInput(message: string): Promise<boolean> {
    if (message.startsWith("/")) {
      return this.handleCommand(message);
    }

    this.pushEntry("user", "you", message);
    this.thread.input.push(stringToUserMessage(message));
    await this.runTurn();
    return true;
  }

  private async handleCommand(commandLine: string): Promise<boolean> {
    const [command, ...rest] = commandLine.split(/\s+/);
    const value = rest.join(" ").trim();

    switch (command) {
      case "/help":
        this.pushEntry(
          "meta",
          "help",
          [
            "/help shows command help.",
            "/provider <openai|openai-codex|anthropic|anthropic-oauth> switches providers and keeps the current in-memory transcript.",
            "/model <name> changes the active model.",
            "/new starts a fresh chat.",
            "/clear clears the visible transcript panel only.",
            "/exit leaves the TUI.",
          ].join("\n"),
        );
        return true;

      case "/provider": {
        const nextProvider = parseProvider(value);
        if (!nextProvider) {
          this.pushEntry(
            "error",
            "config",
            "Provider must be `openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`.",
          );
          return true;
        }

        const previousProvider = this.providerName;
        const previousThread = this.thread;

        try {
          this.providerName = nextProvider;
          this.model = defaultModel(nextProvider);
          this.thread = this.buildThread(previousThread.input);
          this.pushEntry(
            "meta",
            "config",
            `Provider switched from ${previousProvider} to ${nextProvider}. Model reset to ${this.model}.`,
          );
        } catch (error) {
          this.providerName = previousProvider;
          this.thread = previousThread;
          this.pushEntry("error", "config", error instanceof Error ? error.message : String(error));
        }
        return true;
      }

      case "/model":
        if (!value) {
          this.pushEntry("error", "config", "Usage: /model <name>");
          return true;
        }

        this.model = value;
        this.thread = this.buildThread(this.thread.input);
        this.pushEntry("meta", "config", `Model set to ${value}.`);
        return true;

      case "/new":
        this.thread = this.buildThread([]);
        this.transcript.length = 0;
        this.pushEntry("meta", "welcome", "Started a fresh chat.");
        return true;

      case "/clear":
        this.transcript.length = 0;
        this.pushEntry("meta", "view", "Cleared the visible transcript.");
        return true;

      case "/exit":
      case "/quit":
        return false;

      default:
        this.pushEntry("error", "command", `Unknown command: ${command}`);
        return true;
    }
  }

  private async runTurn(): Promise<void> {
    const keyMessage = missingApiKeyMessage(this.providerName);
    if (keyMessage) {
      this.pushEntry("error", "auth", keyMessage);
      this.render();
      return;
    }

    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;

    this.status = `${spinnerFrames[0]} Panda is thinking`;
    this.render();

    const spinner = setInterval(() => {
      frame = (frame + 1) % spinnerFrames.length;
      this.status = `${spinnerFrames[frame]} Panda is thinking`;
      this.render();
    }, 100);

    try {
      for await (const outputItem of this.thread.run()) {
        switch (outputItem.type) {
          case "function_call":
            this.pushEntry(
              "tool",
              String(outputItem.name ?? "tool"),
              parseToolCall(String(outputItem.arguments ?? "")),
            );
            break;

          case "function_call_output":
            this.pushEntry("tool", "result", parseToolOutput(String(outputItem.output ?? "")));
            break;

          case "message": {
            const parts = Array.isArray(outputItem.content) ? outputItem.content : [];
            const text = parts
              .map((part) => (typeof part?.text === "string" ? part.text : ""))
              .filter(Boolean)
              .join("");
            if (text) {
              this.pushEntry("assistant", "panda", text);
            }
            break;
          }

          default:
            this.pushEntry("meta", "event", JSON.stringify(outputItem, null, 2));
            break;
        }

        this.render();
      }
    } catch (error) {
      this.pushEntry("error", "error", error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(spinner);
      this.status = "";
      this.render();
    }
  }

  private render(): void {
    const width = Math.max(72, Math.min(output.columns || 100, 120));
    const headerLines = box(
      [
        `${theme.bold(theme.coral("Panda"))} ${theme.dim("local chat console")}`,
        `${theme.slate("provider")} ${theme.white(this.providerName)}   ${theme.slate("model")} ${theme.white(this.model)}`,
        `${theme.slate("cwd")} ${this.cwd}`,
        `${theme.slate("commands")} /help  /provider <name>  /model <name>  /new  /clear  /exit`,
      ],
      width,
    );

    const transcriptLines = this.transcript.flatMap((entry) => {
      const label =
        entry.role === "assistant"
          ? theme.bold(theme.coral(entry.title))
          : entry.role === "user"
            ? theme.bold(theme.cyan(entry.title))
            : entry.role === "tool"
              ? theme.bold(theme.gold(entry.title))
              : entry.role === "error"
                ? theme.bold(theme.coral(entry.title))
                : theme.bold(theme.slate(entry.title));

      const wrapped = wrapText(entry.body, width - 8);
      return wrapped.map((line, index) => {
        return index === 0 ? `${padAnsiEnd(label, 18)}${line}` : `${" ".repeat(18)}${line}`;
      });
    });

    const footer = this.status ? theme.mint(this.status) : theme.dim("Enter a message or a slash command.");
    const availableTranscriptLines = Math.max(8, (output.rows || 32) - headerLines.length - 5);
    const visibleTranscript = transcriptLines.slice(-availableTranscriptLines);

    output.write(CLEAR_SCREEN);
    output.write([...headerLines, "", ...visibleTranscript, "", footer, ""].join("\n"));
  }

  private enterScreen(): void {
    output.write(ALT_SCREEN_ON);
    output.write(CLEAR_SCREEN);
  }

  private exitScreen(): void {
    output.write(ALT_SCREEN_OFF);
  }
}

export async function runChatCli(options: ChatCliOptions = {}): Promise<void> {
  const app = new PandaChatApp(options);
  await app.run();
}
