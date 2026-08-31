const META_GRAPH_ORIGIN = "https://graph.facebook.com";
const MAX_META_RESPONSE_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 256 * 1024;
const META_REQUEST_TIMEOUT_MS = 10_000;

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_META_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Meta call response exceeded the configured limit.");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export interface WhatsAppMetaCallClientOptions {
  accessToken: string;
  graphVersion: string;
  phoneNumberId: string;
  fetchImpl?: typeof fetch;
}

/** Owns the small, official Graph signalling surface for one Cloud Calling number. */
export class WhatsAppMetaCallClient {
  constructor(private readonly options: WhatsAppMetaCallClientOptions) {}

  preAccept(callId: string, answerSdp: string, signal?: AbortSignal): Promise<void> {
    return this.signal(callId, "pre_accept", answerSdp, signal);
  }

  accept(callId: string, answerSdp: string, signal?: AbortSignal): Promise<void> {
    return this.signal(callId, "accept", answerSdp, signal);
  }

  reject(callId: string, signal?: AbortSignal): Promise<void> { return this.signal(callId, "reject", undefined, signal); }
  terminate(callId: string, signal?: AbortSignal): Promise<void> { return this.signal(callId, "terminate", undefined, signal); }

  private async signal(callId: string, action: string, sdp?: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(callId)) throw new Error("Invalid WhatsApp call id.");
    if (sdp !== undefined && Buffer.byteLength(sdp) > MAX_SDP_BYTES) throw new Error("WhatsApp SDP answer exceeded the configured limit.");
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(META_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(META_REQUEST_TIMEOUT_MS);
    const response = await (this.options.fetchImpl ?? fetch)(
      `${META_GRAPH_ORIGIN}/${this.options.graphVersion}/${this.options.phoneNumberId}/calls`,
      {
        method: "POST",
        headers: {Authorization: `Bearer ${this.options.accessToken}`, "Content-Type": "application/json"},
        body: JSON.stringify({
          messaging_product: "whatsapp",
          call_id: callId,
          action,
          ...(sdp === undefined ? {} : {session: {sdp_type: "answer", sdp}}),
        }),
        signal: requestSignal,
      },
    );
    const responseText = await boundedResponse(response);
    if (!response.ok) throw Object.assign(new Error(`Meta WhatsApp call ${action} failed (${response.status}).`), {status: response.status});
    if (responseText) {
      let parsed: unknown;
      try { parsed = JSON.parse(responseText) as unknown; } catch { throw new Error(`Meta WhatsApp call ${action} returned invalid JSON.`); }
      if (typeof parsed !== "object" || parsed === null || !("success" in parsed) || parsed.success !== true) throw new Error(`Meta WhatsApp call ${action} was not acknowledged.`);
    }
  }
}
