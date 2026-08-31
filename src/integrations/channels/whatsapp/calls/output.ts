import type {JsonObject} from "../../../../lib/json.js";
import type {LiveVoiceOutput, LiveVoiceOutputSnapshot} from "../../../voice/live-call.js";
import type {WhatsAppCallPeerLike} from "./peer.js";

/** Adapts one WhatsApp RTP sender to the channel-neutral live-call output seam. */
export class WhatsAppCallOutput implements LiveVoiceOutput {
  private responseEpoch = 0;
  private overruns = 0;

  constructor(private readonly peer: WhatsAppCallPeerLike) {}

  pushPcm(audio: Buffer): void { if (this.peer.pushPcm(audio) > 0) this.overruns += 1; }
  interrupt(): void { this.responseEpoch += 1; this.peer.clearOutput(); }
  reset(): void { this.responseEpoch += 1; this.peer.clearOutput(); }

  getSnapshot(): LiveVoiceOutputSnapshot {
    const peer = this.peer.snapshot();
    return {
      state: peer.state,
      responseEpoch: this.responseEpoch,
      queuedMs: peer.queuedMs,
      overruns: this.overruns,
      droppedMs: peer.droppedOutputMs,
      transport: peer as unknown as JsonObject,
    };
  }
}
