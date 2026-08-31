import type {LiveVoiceProviderDefinition} from "../../voice/provider.js";
import {OpenAILiveRealtimeVoiceBridge} from "./bridge.js";
import {OPENAI_LIVE_MODEL} from "./types.js";
import {DEFAULT_OPENAI_LIVE_VOICE, parseOpenAILiveVoice} from "./voices.js";

export interface OpenAILiveVoiceProviderOptions {
  env?: NodeJS.ProcessEnv;
  voice?: string;
  log(event: string, payload: Record<string, unknown>): void;
}

/** Binds OpenAI Live auth and wire configuration behind the channel-neutral provider contract. */
export function createOpenAILiveVoiceProvider(options: OpenAILiveVoiceProviderOptions): LiveVoiceProviderDefinition {
  const voice = parseOpenAILiveVoice(options.voice ?? DEFAULT_OPENAI_LIVE_VOICE);
  return {
    id: "openai-live",
    model: OPENAI_LIVE_MODEL,
    createSession: (callbacks) => new OpenAILiveRealtimeVoiceBridge({
      env: options.env,
      voice,
      initialItems: callbacks.initialItems,
      onAudio: callbacks.onAudio,
      onDelegation: callbacks.onDelegation,
      onOutputAudioCleared: callbacks.onOutputAudioCleared,
      onTurnDone: callbacks.onTurnDone,
      onFailure: callbacks.onFailure,
      log: options.log,
    }),
  };
}
