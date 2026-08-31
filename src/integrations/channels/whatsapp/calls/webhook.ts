import {createHmac, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";

import {isJsonObject} from "../../../../lib/json.js";
import type {WhatsAppCallEvent} from "./types.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE = 120;
const MAX_EVENTS_PER_WEBHOOK = 16;
const MAX_IN_FLIGHT_REQUESTS = 32;

export interface WhatsAppCallWebhookRegistration {
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  onEvent(event: WhatsAppCallEvent): Promise<void> | void;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyMetaWebhookSignature(body: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  return constantTimeEquals(signature, expected);
}

function extractPhoneNumberId(payload: unknown): string | null {
  if (!isJsonObject(payload) || !Array.isArray(payload.entry)) return null;
  for (const entry of payload.entry) {
    if (!isJsonObject(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isJsonObject(change) || !isJsonObject(change.value) || !isJsonObject(change.value.metadata)) continue;
      const value = change.value.metadata.phone_number_id;
      if (typeof value === "string") return value;
    }
  }
  return null;
}

export function parseWhatsAppCallEvents(payload: unknown): WhatsAppCallEvent[] {
  if (!isJsonObject(payload) || !Array.isArray(payload.entry)) return [];
  const events: WhatsAppCallEvent[] = [];
  for (const entry of payload.entry) {
    if (!isJsonObject(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isJsonObject(change) || change.field !== "calls" || !isJsonObject(change.value) || !isJsonObject(change.value.metadata)) continue;
      const phoneNumberId = change.value.metadata.phone_number_id;
      if (typeof phoneNumberId !== "string" || !Array.isArray(change.value.calls)) continue;
      for (const candidate of change.value.calls) {
        if (events.length >= MAX_EVENTS_PER_WEBHOOK) return events;
        if (!isJsonObject(candidate) || typeof candidate.id !== "string" || typeof candidate.event !== "string" || typeof candidate.timestamp !== "string") continue;
        if (candidate.event !== "connect" && candidate.event !== "terminate") continue;
        const session = isJsonObject(candidate.session) ? candidate.session : undefined;
        const offerSdp = session?.sdp_type === "offer" && typeof session.sdp === "string" ? session.sdp : undefined;
        if (offerSdp && Buffer.byteLength(offerSdp) > 256 * 1024) continue;
        events.push({
          callId: candidate.id.slice(0, 256), phoneNumberId, event: candidate.event,
          ...(typeof candidate.from === "string" ? {from: candidate.from} : {}),
          ...(typeof candidate.from_user_id === "string" ? {fromUserId: candidate.from_user_id} : {}),
          timestamp: candidate.timestamp.slice(0, 64), ...(offerSdp ? {offerSdp} : {}),
        });
      }
    }
  }
  return events;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) { tooLarge = true; return; }
      if (!tooLarge) chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => tooLarge ? reject(Object.assign(new Error("Webhook body too large."), {status: 413})) : resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function respond(response: ServerResponse, status: number, body = ""): void {
  response.writeHead(status, {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"});
  response.end(body);
}

/** One process-level signed webhook host shared by all Meta Cloud call connectors. */
export class WhatsAppCallWebhookServer {
  private readonly registrations = new Map<string, WhatsAppCallWebhookRegistration>();
  private readonly rates = new Map<string, {window: number; count: number}>();
  private server?: Server;
  private startPromise?: Promise<void>;
  private inFlight = 0;

  constructor(private readonly options: {host: string; port: number; log(event: string, payload: Record<string, unknown>): void}) {}

  register(registration: WhatsAppCallWebhookRegistration): () => void {
    if (this.registrations.has(registration.phoneNumberId)) throw new Error(`WhatsApp phone number ${registration.phoneNumberId} is registered twice.`);
    this.registrations.set(registration.phoneNumberId, registration);
    return () => { if (this.registrations.get(registration.phoneNumberId) === registration) this.registrations.delete(registration.phoneNumberId); };
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.server?.listening) return;
    this.startPromise = (async () => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      server.maxHeadersCount = 64;
      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.options.port, this.options.host, () => { server.off("error", reject); resolve(); });
        });
      } catch (error) {
        server.removeAllListeners();
        if (this.server === server) this.server = undefined;
        throw error;
      }
    })().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  address(): AddressInfo | null {
    const address = this.server?.address();
    return typeof address === "object" ? address : null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let admitted = false;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/webhooks/whatsapp/calls") { respond(response, 404); return; }
      if (this.inFlight >= MAX_IN_FLIGHT_REQUESTS) { respond(response, 503); return; }
      this.inFlight += 1; admitted = true;
      const address = request.socket.remoteAddress ?? "unknown";
      if (request.method === "GET") { this.verifyChallenge(url, response, address); return; }
      if (request.method !== "POST") { respond(response, 405); return; }
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { respond(response, 415); return; }
      const body = await readBody(request);
      let payload: unknown;
      try { payload = JSON.parse(body.toString("utf8")) as unknown; } catch { respond(response, 400); return; }
      const phoneNumberId = extractPhoneNumberId(payload);
      const registration = phoneNumberId ? this.registrations.get(phoneNumberId) : undefined;
      const signature = Array.isArray(request.headers["x-hub-signature-256"]) ? request.headers["x-hub-signature-256"][0] : request.headers["x-hub-signature-256"];
      if (!registration || !verifyMetaWebhookSignature(body, signature, registration.appSecret)) { respond(response, this.allowUnauthenticated(address) ? 401 : 429); return; }
      const events = parseWhatsAppCallEvents(payload).filter((event) => event.phoneNumberId === registration.phoneNumberId);
      respond(response, 200, "EVENT_RECEIVED");
      for (const event of events) void Promise.resolve(registration.onEvent(event)).catch((error: unknown) => this.options.log("whatsapp_call_event_failed", {phoneNumberId, callId: event.callId, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)}));
    } catch (error) {
      if (!response.headersSent) respond(response, typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500);
      this.options.log("whatsapp_call_webhook_failed", {message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)});
    } finally { if (admitted) this.inFlight -= 1; }
  }

  private verifyChallenge(url: URL, response: ServerResponse, address: string): void {
    if (url.searchParams.get("hub.mode") !== "subscribe") { respond(response, this.allowUnauthenticated(address) ? 403 : 429); return; }
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    let matched = false;
    for (const registration of this.registrations.values()) matched = constantTimeEquals(token, registration.verifyToken) || matched;
    if (!matched || !challenge || challenge.length > 512) { respond(response, this.allowUnauthenticated(address) ? 403 : 429); return; }
    respond(response, 200, challenge);
  }

  private allowUnauthenticated(address: string): boolean {
    const window = Math.floor(Date.now() / 60_000);
    const current = this.rates.get(address);
    if (this.rates.size > 1_024) for (const [key, value] of this.rates) if (value.window !== window) this.rates.delete(key);
    if (!current || current.window !== window) {
      if (this.rates.size >= 2_048 && !this.rates.has(address)) return false;
      this.rates.set(address, {window, count: 1}); return true;
    }
    current.count += 1;
    return current.count <= MAX_REQUESTS_PER_MINUTE;
  }
}
