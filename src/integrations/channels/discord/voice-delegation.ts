import type {LiveVoiceDelegationRenderInput} from "../../voice/request-handler.js";
import {renderDiscordVoiceDelegation} from "../../../prompts/channels/discord-voice.js";
import {DISCORD_SOURCE} from "./config.js";

/** Adapts generic live-voice provenance to Panda's Discord-specific delegation prompt. */
export function renderDiscordLiveVoiceDelegation(input: LiveVoiceDelegationRenderInput): string {
  if (input.liveSession.source !== DISCORD_SOURCE) throw new Error(`Expected Discord live voice source, got ${input.liveSession.source}.`);
  return renderDiscordVoiceDelegation({
    prompt: input.turn.prompt,
    connectorKey: input.liveSession.connectorKey,
    guildId: input.liveSession.scopeKey,
    channelId: input.liveSession.roomKey,
    voiceTurnId: input.turn.id,
    speakerId: input.turn.externalActorId,
  });
}
