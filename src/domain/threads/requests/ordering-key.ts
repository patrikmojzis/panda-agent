import {createHash} from "node:crypto";

import type {
  CreateRuntimeRequestInput,
  RuntimeRequestKind,
  RuntimeRequestPayloadByKind,
} from "./types.js";

function keyParts<K extends RuntimeRequestKind>(
  kind: K,
  payload: RuntimeRequestPayloadByKind[K],
): readonly string[] {
  switch (kind) {
    case "a2a_message":
      return ["session", (payload as RuntimeRequestPayloadByKind["a2a_message"]).toSessionId];
    case "telegram_message":
    case "telegram_reaction": {
      const message = payload as RuntimeRequestPayloadByKind["telegram_message"];
      return ["conversation", "telegram", message.connectorKey, message.externalConversationId];
    }
    case "whatsapp_message":
    case "whatsapp_reaction": {
      const message = payload as RuntimeRequestPayloadByKind["whatsapp_message"];
      return ["conversation", "whatsapp", message.connectorKey, message.externalConversationId];
    }
    case "discord_message": {
      const message = payload as RuntimeRequestPayloadByKind["discord_message"];
      return ["conversation", "discord", message.connectorKey, message.externalConversationId];
    }
    case "live_voice_delegation": {
      const voice = payload as RuntimeRequestPayloadByKind["live_voice_delegation"];
      return ["session", voice.sessionId];
    }
    case "tui_input": {
      const input = payload as RuntimeRequestPayloadByKind["tui_input"];
      return input.threadId
        ? ["thread", input.threadId]
        : ["identity-main", input.identityId ?? "anonymous"];
    }
    case "create_branch_session":
      return ["session", (payload as RuntimeRequestPayloadByKind["create_branch_session"]).sessionId];
    case "create_subagent_session":
      return ["session", (payload as RuntimeRequestPayloadByKind["create_subagent_session"]).parentSessionId];
    case "resolve_main_session_thread": {
      const resolve = payload as RuntimeRequestPayloadByKind["resolve_main_session_thread"];
      return ["identity-main", resolve.identityId ?? "anonymous", resolve.agentKey ?? "default"];
    }
    case "resolve_thread_run_config":
    case "abort_thread":
    case "compact_thread":
    case "update_thread":
      return ["thread", (payload as RuntimeRequestPayloadByKind["compact_thread"]).threadId];
    case "reset_session": {
      const reset = payload as RuntimeRequestPayloadByKind["reset_session"];
      if (reset.sessionId) return ["session", reset.sessionId];
      if (reset.threadId) return ["thread", reset.threadId];
      if (reset.connectorKey && reset.externalConversationId) {
        return ["conversation", reset.source, reset.connectorKey, reset.externalConversationId];
      }
      return ["identity-main", reset.identityId ?? "anonymous", reset.agentKey ?? "default"];
    }
    case "compact_session":
      return ["session", (payload as RuntimeRequestPayloadByKind["compact_session"]).sessionId];
    case "archive_session":
    case "restore_session":
      return ["session", (payload as RuntimeRequestPayloadByKind["archive_session"]).sessionId];
  }
}

/** Stable, bounded identifier for the causal stream whose requests must remain FIFO. */
export function deriveRuntimeRequestOrderingKey<K extends RuntimeRequestKind>(
  input: CreateRuntimeRequestInput<K>,
): string {
  const parts = keyParts(input.kind, input.payload);
  if (parts.some((part) => !part)) {
    throw new Error(`Runtime request ${input.kind} cannot derive a non-empty ordering key.`);
  }
  return `v1:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** Binds transport redelivery to one durable request without exposing raw external identifiers. */
export function deriveRuntimeRequestIngressIdempotencyKey(input: {
  kind: Extract<RuntimeRequestKind,
    | "a2a_message"
    | "discord_message"
    | "telegram_message"
    | "telegram_reaction"
    | "whatsapp_message"
    | "whatsapp_reaction">;
  connectorKey: string;
  externalEventScope?: string;
  externalEventId: string;
}): string {
  if (!input.connectorKey || !input.externalEventId) {
    throw new Error(`Runtime request ${input.kind} cannot derive an ingress idempotency key.`);
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([
      input.kind,
      input.connectorKey,
      input.externalEventScope ?? null,
      input.externalEventId,
    ]))
    .digest("hex");
  return `ingress:v1:${digest}`;
}
