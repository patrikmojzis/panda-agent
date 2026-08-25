import type {LiveVoiceProviderDefinition} from "../../voice/provider.js";
import {OpenAILiveRealtimeVoiceBridge} from "./bridge.js";
import {OPENAI_LIVE_MODEL} from "./types.js";

export interface OpenAILiveVoiceProviderOptions {
  env?: NodeJS.ProcessEnv;
  voice?: string;
  log(event: string, payload: Record<string, unknown>): void;
}

/** Binds OpenAI Live auth and wire configuration behind the channel-neutral provider contract. */
export function createOpenAILiveVoiceProvider(options: OpenAILiveVoiceProviderOptions): LiveVoiceProviderDefinition {
  return {
    id: "openai-live",
    model: OPENAI_LIVE_MODEL,
    createSession: (callbacks) => new OpenAILiveRealtimeVoiceBridge({
      env: options.env,
      voice: options.voice ?? "cove",
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
