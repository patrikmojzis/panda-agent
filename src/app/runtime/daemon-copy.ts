import {DEFAULT_IDENTITY_HANDLE, type IdentityRecord,} from "../../domain/identity/index.js";
import {resolveModelSelector} from "../../kernel/agent/index.js";
import {buildTelegramPairCommand} from "../../integrations/channels/telegram/helpers.js";
import {resolveProviderApiKey} from "../../integrations/providers/shared/auth.js";
import {getProviderConfig} from "../../integrations/providers/shared/provider.js";

export function buildDaemonAlreadyActiveMessage(daemonKey: string): string {
  return `panda run (${daemonKey}) is already active.`;
}

export function buildHomeAgentMismatchMessage(
  identity: IdentityRecord,
  existingAgentKey: string,
  requestedAgentKey: string,
): string {
  return `Identity ${identity.handle} already has a home thread on agent ${existingAgentKey}. Use 'panda identity switch-home-agent ${identity.handle} ${requestedAgentKey}' to replace it.`;
}

export function buildMissingDefaultAgentMessage(identity: IdentityRecord): string {
  return `Identity ${identity.handle} has no default agent. Set one explicitly before creating a home thread.`;
}

export function buildMissingRuntimeIdentityIdMessage(kind: string): string {
  return `Runtime request ${kind} is missing identityId.`;
}

export function buildMissingSwitchHomeAgentKeyMessage(): string {
  return "Runtime request switch_home_agent is missing agentKey.";
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
  return "Reset Panda. Fresh home thread started.";
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
