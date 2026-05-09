import {randomUUID} from "node:crypto";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {trimToUndefined} from "../../lib/strings.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {BrowserDeviceProfile, BrowserSessionScope} from "../../panda/tools/browser-types.js";

export {buildEndpointUrl as buildRunnerEndpoint} from "../../lib/http.js";

export const DEFAULT_BROWSER_DEVICE_PROFILE: BrowserDeviceProfile = "desktop";

/**
 * Normalizes browser labels into a filesystem-safe token.
 */
export function normalizeBrowserLabelValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "unknown";
}

/**
 * Validates agent keys before they are used in browser-owned filesystem paths.
 */
export function safeAgentKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new ToolError(`Unsafe agent key for browser artifact path: ${agentKey}`);
  }

  return trimmed;
}

/**
 * Resolves the browser artifact scope key from the current transcript context.
 */
export function normalizeBrowserArtifactScopeKey(
  context: DefaultAgentSessionContext,
): {scope: "thread" | "ephemeral"; key: string} {
  const threadId = trimToUndefined(context.threadId);
  if (threadId) {
    return {
      scope: "thread",
      key: threadId,
    };
  }

  return {
    scope: "ephemeral",
    key: `ephemeral-${randomUUID()}`,
  };
}

/**
 * Normalizes the device profile used for browser context isolation.
 */
export function normalizeBrowserDeviceProfile(
  deviceProfile: BrowserDeviceProfile | undefined,
): BrowserDeviceProfile {
  return deviceProfile ?? DEFAULT_BROWSER_DEVICE_PROFILE;
}

/**
 * Resolves the browser runner session key from the durable runtime lane and device profile.
 */
export function normalizeBrowserSessionScopeKey(
  context: DefaultAgentSessionContext,
  deviceProfile: BrowserDeviceProfile | undefined,
): {scope: BrowserSessionScope; key: string; deviceProfile: BrowserDeviceProfile} {
  const normalizedDeviceProfile = normalizeBrowserDeviceProfile(deviceProfile);
  const sessionId = trimToUndefined(context.sessionId);
  if (sessionId) {
    return {
      scope: "session",
      key: `session:${sessionId}:device:${normalizedDeviceProfile}`,
      deviceProfile: normalizedDeviceProfile,
    };
  }

  const threadId = trimToUndefined(context.threadId);
  if (threadId) {
    return {
      scope: "thread",
      key: `thread:${threadId}:device:${normalizedDeviceProfile}`,
      deviceProfile: normalizedDeviceProfile,
    };
  }

  return {
    scope: "ephemeral",
    key: `ephemeral:${randomUUID()}:device:${normalizedDeviceProfile}`,
    deviceProfile: normalizedDeviceProfile,
  };
}
