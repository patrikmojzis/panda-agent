import {randomUUID} from "node:crypto";

import {readMissingApiKeyMessageForModel} from "../../integrations/providers/shared/missing-api-key.js";
import {resolveModelSelector, type ThinkingLevel,} from "../../kernel/agent/index.js";
import {readThreadAgentKey} from "../../domain/threads/runtime/context.js";
import type {ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {ChatRuntimeServices} from "./runtime.js";
import {buildChatHelpText, describeUnknownCommand, runChatCommandLine} from "./chat-commands.js";
import {resolveStoredChatDisplayConfig} from "./chat-session.js";
import {collectThreadUsageSnapshot, formatThreadUsageSnapshot,} from "./usage-summary.js";
import {
    type EntryRole,
    formatThinkingLevel,
    parseThinkingCommandValue,
    thinkingCommandUsage,
    thinkingCommandValuesText
} from "./chat-shared.js";
import {type NoticeState} from "./chat-view.js";

type NoticeTone = NoticeState["tone"];

export interface ChatCommandHost {
  getCurrentThreadId(): string;
  getCurrentSessionId(): string;
  getCurrentAgentKey(): string | undefined;
  getModel(): string;
  getThinking(): ThinkingLevel | undefined;
  isRunning(): boolean;
  requireServices(): ChatRuntimeServices;
  requireIdleRun(action: string): boolean;
  buildSessionDefaults(): {
    sessionId?: string;
    agentKey?: string;
    model?: string;
    thinking?: ThinkingLevel;
  };
  switchThread(thread: ThreadRecord): Promise<void>;
  compactCurrentThread(customInstructions: string): Promise<void>;
  openSessionPicker(): Promise<void>;
  setCurrentThread(thread: ThreadRecord): void;
  setModel(model: string): void;
  setThinking(thinking: ThinkingLevel | undefined): void;
  pushEntry(role: EntryRole, title: string, body: string): void;
  setNotice(text: string, tone: NoticeTone, durationMs?: number): void;
  showCommandError(title: string, message: string): void;
}

export interface ChatComposerHost {
  applySelectedSlashCompletion(): boolean;
  getComposerValue(): string;
  recordHistory(value: string): void;
  clearComposer(): void;
  handleCommand(commandLine: string): Promise<boolean>;
  close(): void;
  setFollowTranscript(enabled: boolean): void;
  getCurrentThreadId(): string;
  isRunning(): boolean;
  queuePendingLocalInput(threadId: string, text: string, id: string): void;
  setNotice(text: string, tone: NoticeTone, durationMs?: number): void;
  submitUserMessage(message: string, externalMessageId: string): Promise<void>;
}

export interface ChatSubmitHost {
  getModel(): string;
  getCurrentThreadId(): string;
  requireServices(): ChatRuntimeServices;
  removePendingLocalInput(id: string): void;
  pushEntry(role: EntryRole, title: string, body: string): void;
  setNotice(text: string, tone: NoticeTone, durationMs?: number): void;
  render(): void;
}

function showHelp(host: ChatCommandHost): boolean {
  host.pushEntry("meta", "help", buildChatHelpText(thinkingCommandUsage()));
  return true;
}

async function handleModelCommand(host: ChatCommandHost, value: string): Promise<boolean> {
  if (!host.requireIdleRun("switching models")) {
    return true;
  }

  if (!value) {
    host.showCommandError("config", "Usage: /model <selector-or-alias|default>");
    return true;
  }

  try {
    const trimmed = value.trim();
    const services = host.requireServices();
    const resetToDefault = trimmed.toLowerCase() === "default";
    const thread = await services.updateThread(host.getCurrentThreadId(), {
      model: resetToDefault ? null : resolveModelSelector(trimmed).canonical,
    });
    const runConfig = resetToDefault
      ? await services.resolveThreadRunConfig(thread.id).catch(() => resolveStoredChatDisplayConfig(thread))
      : {model: thread.model ?? host.getModel()};
    host.setCurrentThread(thread);
    host.setModel(runConfig.model);
    if (resetToDefault) {
      host.pushEntry("meta", "config", `Model reset to default (${runConfig.model}).`);
      host.setNotice(`Model default (${runConfig.model})`, "info");
    } else {
      host.pushEntry("meta", "config", `Model set to ${runConfig.model}.`);
      host.setNotice(`Model ${runConfig.model}`, "info");
    }
  } catch (error) {
    host.showCommandError("config", error instanceof Error ? error.message : String(error));
  }

  return true;
}

async function handleThinkingCommand(host: ChatCommandHost, value: string): Promise<boolean> {
  if (!host.requireIdleRun("changing thinking")) {
    return true;
  }

  if (!value) {
    host.showCommandError("config", `Usage: ${thinkingCommandUsage()}`);
    return true;
  }

  const nextThinking = parseThinkingCommandValue(value);
  if (!nextThinking) {
    host.showCommandError("config", `Thinking must be one of ${thinkingCommandValuesText()}.`);
    return true;
  }

  try {
    const thread = await host.requireServices().updateThread(host.getCurrentThreadId(), {
      thinking: nextThinking === "off" ? null : nextThinking,
    });
    host.setCurrentThread(thread);
    host.setThinking(thread.thinking);
    if (thread.thinking) {
      host.pushEntry("meta", "config", `Thinking set to ${thread.thinking}.`);
      host.setNotice(`Thinking ${thread.thinking}`, "info");
    } else {
      host.pushEntry("meta", "config", "Thinking disabled.");
      host.setNotice("Thinking off", "info");
    }
  } catch (error) {
    host.showCommandError("config", error instanceof Error ? error.message : String(error));
  }

  return true;
}

async function handleUsageCommand(host: ChatCommandHost): Promise<boolean> {
  try {
    const services = host.requireServices();
    const threadId = host.getCurrentThreadId();
    const [thread, transcript] = await Promise.all([
      services.getThread(threadId),
      services.store.loadTranscript(threadId),
    ]);
    const runConfig = await services.resolveThreadRunConfig(threadId)
      .catch(() => resolveStoredChatDisplayConfig(thread));
    const summary = formatThreadUsageSnapshot(collectThreadUsageSnapshot({
      thread,
      transcript,
      model: runConfig.model,
      thinking: runConfig.thinking,
      isRunning: host.isRunning(),
    }));

    host.pushEntry("meta", "usage", summary);
    host.setNotice("Added a usage snapshot.", "info");
  } catch (error) {
    host.showCommandError("usage", error instanceof Error ? error.message : String(error));
  }

  return true;
}

async function handleCompactCommand(host: ChatCommandHost, value: string): Promise<boolean> {
  if (!host.requireIdleRun("compacting")) {
    return true;
  }

  try {
    await host.compactCurrentThread(value);
  } catch (error) {
    host.showCommandError("compact", error instanceof Error ? error.message : String(error));
  }

  return true;
}

async function handleNewSessionCommand(host: ChatCommandHost): Promise<boolean> {
  if (!host.requireIdleRun("creating a branch session")) {
    return true;
  }

  const thread = await host.requireServices().createBranchSession(host.buildSessionDefaults());
  await host.switchThread(thread);
  host.pushEntry("meta", "session", `Started branch session ${thread.sessionId}.`);
  host.setNotice(`Started branch session ${thread.sessionId}.`, "info");
  return true;
}

async function handleResetSessionCommand(host: ChatCommandHost): Promise<boolean> {
  if (!host.requireIdleRun("resetting Panda")) {
    return true;
  }

  try {
    const thread = await host.requireServices().resetSession({
      ...host.buildSessionDefaults(),
      sessionId: host.getCurrentSessionId(),
    });
    await host.switchThread(thread);
    host.pushEntry("meta", "session", `Reset session ${thread.sessionId}.`);
    host.setNotice(`Reset session ${thread.sessionId}.`, "info");
  } catch (error) {
    host.showCommandError("session", error instanceof Error ? error.message : String(error));
  }

  return true;
}

async function handleResumeCommand(host: ChatCommandHost, value: string): Promise<boolean> {
  if (!host.requireIdleRun("opening another session")) {
    return true;
  }

  if (!value) {
    host.showCommandError("session", "Usage: /resume <session-id>");
    return true;
  }

  try {
    const thread = await host.requireServices().openSession(value);
    const currentAgentKey = host.getCurrentAgentKey();
    const nextAgentKey = readThreadAgentKey(thread);
    if (currentAgentKey && nextAgentKey !== currentAgentKey) {
      throw new Error(`Session ${value} belongs to agent ${nextAgentKey}, not current agent ${currentAgentKey}.`);
    }

    await host.switchThread(thread);
    host.pushEntry("meta", "session", `Opened session ${thread.sessionId}.`);
    host.setNotice(`Opened session ${thread.sessionId}.`, "info");
  } catch (error) {
    host.showCommandError("session", error instanceof Error ? error.message : String(error));
  }

  return true;
}

function showThreadSummary(host: ChatCommandHost): boolean {
  host.pushEntry(
    "meta",
    "session",
    [
      `identity ${host.requireServices().identity.handle}`,
      `agent ${host.getCurrentAgentKey() ?? "-"}`,
      `session ${host.getCurrentSessionId()}`,
      `thread ${host.getCurrentThreadId()}`,
      `model ${host.getModel()}`,
      `thinking ${formatThinkingLevel(host.getThinking())}`,
    ].join("\n"),
  );
  return true;
}

async function handleAbortCommand(host: ChatCommandHost): Promise<boolean> {
  if (!host.isRunning()) {
    host.setNotice("No active run to abort.", "info");
    return true;
  }

  if (await host.requireServices().abortThread(host.getCurrentThreadId(), "Aborted from the TUI.")) {
    host.setNotice("Aborting the active run...", "info");
  } else {
    host.setNotice("No active run to abort.", "info");
  }

  return true;
}

function handleExitCommand(host: ChatCommandHost): boolean {
  if (host.isRunning()) {
    host.setNotice("Wait for the current turn to finish before exiting.", "info");
    return true;
  }

  return false;
}

function handleUnknownCommand(host: ChatCommandHost, command: string): boolean {
  host.showCommandError("command", describeUnknownCommand(command));
  return true;
}

// Keep slash-command behavior out of chat.ts so that file stays focused on TUI wiring.
export async function runChatActionsCommandLine(
  commandLine: string,
  host: ChatCommandHost,
): Promise<boolean> {
  return await runChatCommandLine(commandLine, {
    help: () => showHelp(host),
    usage: () => handleUsageCommand(host),
    model: (value) => handleModelCommand(host, value),
    thinking: (value) => handleThinkingCommand(host, value),
    compact: (value) => handleCompactCommand(host, value),
    newSession: () => handleNewSessionCommand(host),
    resetSession: () => handleResetSessionCommand(host),
    resume: (value) => handleResumeCommand(host, value),
    showThread: () => showThreadSummary(host),
    openSessionPicker: async () => {
      await host.openSessionPicker();
      return true;
    },
    abort: () => handleAbortCommand(host),
    exit: () => handleExitCommand(host),
    unknown: (command) => handleUnknownCommand(host, command),
  });
}

export async function submitChatComposer(host: ChatComposerHost): Promise<void> {
  if (host.applySelectedSlashCompletion()) {
    return;
  }

  const message = host.getComposerValue().trimEnd();
  if (!message.trim()) {
    host.setNotice("Type a message or slash command first.", "info");
    return;
  }

  host.recordHistory(message);
  host.clearComposer();

  if (message.startsWith("/")) {
    const shouldContinue = await host.handleCommand(message);
    if (!shouldContinue) {
      host.close();
    }
    return;
  }

  host.setFollowTranscript(true);
  const externalMessageId = randomUUID();
  host.queuePendingLocalInput(host.getCurrentThreadId(), message, externalMessageId);
  if (host.isRunning()) {
    host.setNotice("Queued your message for the current session.", "info");
  }
  void host.submitUserMessage(message, externalMessageId);
}

export async function submitChatUserMessage(
  host: ChatSubmitHost,
  message: string,
  externalMessageId: string,
): Promise<void> {
  const keyMessage = readMissingApiKeyMessageForModel(host.getModel());
  if (keyMessage) {
    host.removePendingLocalInput(externalMessageId);
    host.pushEntry("error", "auth", keyMessage);
    host.setNotice(keyMessage, "error", 6_000);
    host.render();
    return;
  }

  try {
    await host.requireServices().submitTextInput({
      threadId: host.getCurrentThreadId(),
      text: message,
      externalMessageId,
      actorId: "local-user",
    });
  } catch (error) {
    host.removePendingLocalInput(externalMessageId);
    const errorMessage = error instanceof Error ? error.message : String(error);
    host.pushEntry("error", "error", errorMessage);
    host.setNotice(errorMessage, "error", 6_000);
    host.render();
  }
}
