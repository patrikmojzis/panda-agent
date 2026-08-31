import {OPENAI_LIVE_MODEL} from "./types.js";

/** Codex AVAS Realtime V1/V3 voices, synced from Codex commit 2c4a95736bea64256a50f7b8506bd33c181cc85a. */
export const OPENAI_LIVE_VOICES = Object.freeze([
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const);

export type OpenAILiveVoice = (typeof OPENAI_LIVE_VOICES)[number];

export const DEFAULT_OPENAI_LIVE_VOICE: OpenAILiveVoice = "cove";

export const OPENAI_LIVE_VOICE_CATALOG = Object.freeze({
  provider: "openai-live",
  model: OPENAI_LIVE_MODEL,
  sourceVersion: "codex-avas-v1-v3@2c4a95736bea64256a50f7b8506bd33c181cc85a",
  defaultVoice: DEFAULT_OPENAI_LIVE_VOICE,
  voices: OPENAI_LIVE_VOICES,
});

const voiceSet = new Set<string>(OPENAI_LIVE_VOICES);

export class UnsupportedOpenAILiveVoiceError extends Error {
  readonly code = "unsupported_voice";
  readonly voice: string;

  constructor(voice: string) {
    const boundedVoice = voice.slice(0, 64);
    super(`Unsupported GPT-Live V1/V3 voice ${JSON.stringify(boundedVoice)}. Allowed voices: ${OPENAI_LIVE_VOICES.join(", ")}.`);
    this.name = "UnsupportedOpenAILiveVoiceError";
    this.voice = boundedVoice;
  }
}

/** Validates one voice against the private Codex AVAS V1/V3 catalogue. */
export function parseOpenAILiveVoice(value: unknown): OpenAILiveVoice {
  const voice = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!voiceSet.has(voice)) throw new UnsupportedOpenAILiveVoiceError(voice);
  return voice as OpenAILiveVoice;
}
