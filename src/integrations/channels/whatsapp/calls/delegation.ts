import type {LiveVoiceDelegationRenderInput} from "../../../voice/request-handler.js";
import {renderWhatsAppVoiceDelegation} from "../../../../prompts/channels/whatsapp-voice.js";
import {WHATSAPP_SOURCE} from "../config.js";
import {parseWhatsAppAuthorizationSnapshot, type WhatsAppActorAuthorizer} from "../authorization.js";

export async function authorizeWhatsAppLiveVoiceDelegation(
  input: LiveVoiceDelegationRenderInput,
  authorizer: WhatsAppActorAuthorizer,
): Promise<boolean> {
  if (input.liveSession.source !== WHATSAPP_SOURCE) return true;
  const authorization = parseWhatsAppAuthorizationSnapshot(input.turn.transportAuthorization);
  if (
    !authorization
    || authorization.identityId !== input.turn.identityId
    || authorization.agentKey !== input.turn.agentKey
  ) return false;
  return authorizer.reauthorizeCall({
    connectorKey: input.liveSession.connectorKey,
    sessionId: input.turn.sessionId,
    authorization,
  });
}

export function renderWhatsAppLiveVoiceDelegation(input: LiveVoiceDelegationRenderInput): string {
  if (input.liveSession.source !== WHATSAPP_SOURCE) throw new Error(`Expected WhatsApp live voice source, got ${input.liveSession.source}.`);
  return renderWhatsAppVoiceDelegation({prompt: input.turn.prompt, connectorKey: input.liveSession.connectorKey, callId: input.liveSession.scopeKey, voiceTurnId: input.turn.id, speakerId: input.turn.externalActorId});
}
