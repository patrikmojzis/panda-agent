import {hasAudiblePcm16} from "../../../voice/pcm.js";
import type {LiveVoiceCall} from "../../../voice/live-call.js";
import type {JsonObject} from "../../../../lib/json.js";

const SILENCE_MS = 500;
const MAX_UTTERANCE_MS = 60_000;

/** Segments one remote WhatsApp caller without making provider playback decisions. */
export class WhatsAppCallCapture {
  private captureId?: string;
  private startedAt?: number;
  private lastAudibleAt?: number;
  private silenceTimer?: NodeJS.Timeout;

  constructor(private readonly input: {actorId: string; identityId: string; transportAuthorization: JsonObject; getCall(): LiveVoiceCall | undefined}) {}

  push(pcm24kMono: Buffer, now = Date.now()): void {
    const call = this.input.getCall();
    if (!call) return;
    const audible = hasAudiblePcm16(pcm24kMono);
    if (!this.captureId && audible) {
      const decision = call.beginCapture(this.input.actorId, now, this.input.identityId, null, this.input.transportAuthorization);
      if (decision.status !== "accepted" && decision.status !== "continued") return;
      this.captureId = decision.captureId; this.startedAt = now;
    }
    const captureId = this.captureId;
    if (!captureId) return;
    if (audible) {
      this.lastAudibleAt = now;
      this.scheduleSilenceCheck();
    }
    call.pushAudio(captureId, pcm24kMono);
    if (this.startedAt !== undefined && now - this.startedAt >= MAX_UTTERANCE_MS) { this.end(); return; }
    if (!this.silenceTimer) this.scheduleSilenceCheck();
  }

  close(): void { this.end(); }

  private scheduleSilenceCheck(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    const remaining = Math.max(0, (this.lastAudibleAt ?? Date.now()) + SILENCE_MS - Date.now());
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      if (this.lastAudibleAt !== undefined && Date.now() - this.lastAudibleAt >= SILENCE_MS) this.end();
      else this.scheduleSilenceCheck();
    }, remaining);
    this.silenceTimer.unref?.();
  }

  private end(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    if (this.captureId) this.input.getCall()?.endCapture(this.captureId);
    this.captureId = undefined; this.startedAt = undefined; this.lastAudibleAt = undefined;
  }
}
