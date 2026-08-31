/** Returns whether the private live-call provider is enabled for this process. */
export function isLiveVoiceEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PANDA_LIVE_VOICE_ENABLED?.trim().toLowerCase() === "true";
}
