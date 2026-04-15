import {DEFAULT_IDENTITY_HANDLE} from "../../domain/identity/index.js";
import {resolveModelSelector} from "../../kernel/agent/index.js";
import {buildTelegramPairCommand} from "../../integrations/channels/telegram/helpers.js";
import {resolveProviderApiKey} from "../../integrations/providers/shared/auth.js";
import {getProviderConfig} from "../../integrations/providers/shared/provider.js";

export function buildDaemonAlreadyActiveMessage(daemonKey: string): string {
  return `panda run (${daemonKey}) is already active.`;
}

export function buildMissingRuntimeIdentityIdMessage(kind: string): string {
  return `Runtime request ${kind} is missing identityId.`;
}

export function buildTelegramStartText(
  actorId: string,
  defaultIdentityHandle = DEFAULT_IDENTITY_HANDLE,
): string {
  return [
    "Pair this Telegram account with Panda by running:",
    buildTelegramPairCommand(actorId, defaultIdentityHandle),
    "",
    "Adjust the identity handle if you want a different Panda identity.",
  ].join("\n");
}

export function buildTelegramNewIsTuiOnlyText(): string {
  return "/new is TUI-only. Use /reset here to start fresh.";
}

export function buildTelegramResetText(): string {
  return "Reset Panda. Fresh session started.";
}

export function buildUnsupportedRuntimeRequestMessage(kind: string): string {
  return `Unsupported runtime request ${kind}.`;
}

export function buildQueuedInputCompactionMessage(): string {
  return "Wait for queued input to run before compacting.";
}

export function resolveMissingApiKeyMessage(modelSelector: string): string | null {
  const selection = resolveModelSelector(modelSelector);
  return resolveProviderApiKey(selection.providerName)
    ? null
    : getProviderConfig(selection.providerName).missingApiKeyMessage;
}
