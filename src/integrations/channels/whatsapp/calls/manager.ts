import type {AgentStore} from "../../../../domain/agents/store.js";
import type {LiveVoiceRepo} from "../../../../domain/live-voice/repo.js";
import {isActiveLiveVoiceTurn} from "../../../../domain/live-voice/types.js";
import type {SessionStore} from "../../../../domain/sessions/store.js";
import type {ConversationRepo} from "../../../../domain/sessions/conversations/repo.js";
import {DrainLoop} from "../../../../lib/drain-loop.js";
import {isJsonObject} from "../../../../lib/json.js";
import {renderLiveVoiceProviderInstructions} from "../../../../prompts/channels/live-voice.js";
import {createOpenAILiveVoiceProvider} from "../../../providers/openai-live/provider.js";
import type {LiveVoiceProviderDefinition} from "../../../voice/provider.js";
import {prepareLiveVoiceCall, resolveLiveVoiceSelection} from "../../../voice/call-start.js";
import {isLiveVoiceEnabled} from "../../../voice/config.js";
import type {LiveVoiceCall} from "../../../voice/live-call.js";
import {sameWhatsAppAuthorization, type AuthorizedWhatsAppActor, type WhatsAppActorAuthorizer} from "../authorization.js";
import {WHATSAPP_SOURCE} from "../config.js";
import {WhatsAppCallCapture} from "./capture.js";
import {WhatsAppMetaCallClient} from "./meta-client.js";
import {WhatsAppCallOutput} from "./output.js";
import {WhatsAppCallPeer, type WhatsAppCallPeerLike} from "./peer.js";
import type {WhatsAppCallControlRepo} from "./postgres.js";
import type {WhatsAppCallControlRecord, WhatsAppCallEvent} from "./types.js";

const STARTUP_TIMEOUT_MS = 45_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_ACTIVE_CALLS = 8;
const MAX_PENDING_OVERFLOW_REJECTIONS = 16;
const EVENT_MAX_AGE_MS = 5 * 60_000;
const MAX_RECENTLY_FINISHED = 2_048;
const MAX_RATE_LIMITED_ACTORS = 512;
const MAX_CONNECT_EVENTS_PER_ACTOR_PER_MINUTE = 10;
const MAX_CONNECT_EVENTS_PER_CONNECTOR_PER_MINUTE = 120;
const processCallSlots = new Set<string>();

interface ActiveCall {
  callId: string;
  sessionId: string;
  agentKey: string;
  liveVoiceSessionId: string;
  call: LiveVoiceCall;
  peer: WhatsAppCallPeerLike;
  capture: WhatsAppCallCapture;
  expiry: NodeJS.Timeout;
  health: NodeJS.Timeout;
  healthBusy: boolean;
  closing: boolean;
  model: string;
  voice: string;
  slotKey: string;
  actorId: string;
  authorization: AuthorizedWhatsAppActor;
}

interface PendingCall {abort: AbortController; promise: Promise<void>}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function controlError(failureCode: string, message: string): string { return JSON.stringify({failureCode, message: message.slice(0, 500)}); }

function abortableStartup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("WhatsApp call startup stopped."));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(undefined, signal.reason instanceof Error ? signal.reason : new Error("WhatsApp call startup stopped."));
    const finish = (value?: T, error?: unknown) => {
      signal.removeEventListener("abort", onAbort);
      error === undefined ? resolve(value as T) : reject(error);
    };
    signal.addEventListener("abort", onAbort, {once: true});
    void operation.then((value) => finish(value), (error: unknown) => finish(undefined, error));
  });
}

function actorId(event: WhatsAppCallEvent): string {
  const digits = event.from?.replace(/\D/g, "") ?? "";
  if (digits.length >= 8 && digits.length <= 15) return `${digits}@s.whatsapp.net`;
  if (event.fromUserId && /^[A-Za-z0-9._:-]{1,128}$/.test(event.fromUserId)) return `bsuid:${event.fromUserId}`;
  throw new Error("WhatsApp call has no supported caller identifier.");
}

function eventTimestamp(value: string): number | null {
  if (/^\d{10,13}$/.test(value)) {
    const parsed = Number(value);
    return value.length === 10 ? parsed * 1_000 : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bindingMatchesAuthorization(metadata: unknown, authorization: AuthorizedWhatsAppActor): boolean {
  const authority = isJsonObject(metadata) && isJsonObject(metadata.channelAuthorization)
    ? metadata.channelAuthorization
    : null;
  return authority?.identityId === authorization.identityId
    && authority.agentKey === authorization.agentKey
    && authority.actorBindingId === authorization.actorBindingId;
}

/** Owns authenticated Meta signalling and one channel-neutral live call per call id. */
export class WhatsAppCallManager {
  private readonly active = new Map<string, ActiveCall>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly overflowRejections = new Map<string, Promise<void>>();
  private readonly recentlyFinished = new Map<string, number>();
  private readonly actorConnectEvents = new Map<string, number[]>();
  private connectEventWindowAt = Date.now();
  private connectEventsInWindow = 0;
  private stopped = false;

  constructor(private readonly options: {
    connectorKey: string;
    accountAgentKey: string;
    phoneNumberId: string;
    env: NodeJS.ProcessEnv;
    meta: WhatsAppMetaCallClient;
    controls: WhatsAppCallControlRepo;
    voice: LiveVoiceRepo;
    agents: Pick<AgentStore, "getAgent">;
    sessions: Pick<SessionStore, "getSession">;
    conversations: Pick<ConversationRepo, "getConversationBinding">;
    authorizer: WhatsAppActorAuthorizer;
    log(event: string, payload: Record<string, unknown>): void;
    createPeer?: (input: {onAudio(pcm24kMono: Buffer): void; onFailure(error: Error): void}) => Promise<WhatsAppCallPeerLike>;
    createProvider?: () => LiveVoiceProviderDefinition;
  }) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.voice.markConnectorSessionsDisconnected(WHATSAPP_SOURCE, this.options.connectorKey, "worker_restarted");
    await this.options.controls.failRunningControls(this.options.connectorKey, controlError("worker_unavailable", "WhatsApp call worker restarted."));
    await this.options.voice.failConnectorActiveTurns(WHATSAPP_SOURCE, this.options.connectorKey, "WhatsApp call worker restarted; any in-flight speech outcome is unknown.");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.abort.abort(new Error("WhatsApp call worker stopped."));
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.promise));
    await Promise.allSettled([...this.active.keys()].map((callId) => this.stopCall(callId, "worker_stopped", false)));
    await Promise.allSettled(this.overflowRejections.values());
  }

  onEvent(event: WhatsAppCallEvent): void {
    if (this.stopped) return;
    if (event.phoneNumberId !== this.options.phoneNumberId) return;
    if (event.event === "terminate") {
      this.pending.get(event.callId)?.abort.abort(new Error("WhatsApp caller terminated during startup."));
      void this.stopCall(event.callId, "remote_terminated", false);
      return;
    }
    if (!event.offerSdp || this.active.has(event.callId) || this.pending.has(event.callId) || this.isRecentlyFinished(event.callId)) return;
    let caller: string;
    try { caller = actorId(event); }
    catch (error) {
      this.options.log("whatsapp_call_event_dropped", {connectorKey: this.options.connectorKey, callId: event.callId, message: safeMessage(error)});
      return;
    }
    if (!this.allowConnectEvent(caller, Date.now())) {
      this.rememberFinished(event.callId);
      this.options.log("whatsapp_call_event_rate_limited", {connectorKey: this.options.connectorKey, callId: event.callId});
      return;
    }
    const slotKey = JSON.stringify([this.options.connectorKey, event.callId]);
    if (processCallSlots.size >= MAX_ACTIVE_CALLS) {
      this.rememberFinished(event.callId);
      this.rejectOverflow(event.callId);
      return;
    }
    processCallSlots.add(slotKey);
    const abort = new AbortController();
    const promise = this.startCall(event, abort, slotKey).catch(async (error: unknown) => {
      if (!this.isRecentlyFinished(event.callId)) {
        this.rememberFinished(event.callId);
        await this.options.meta.reject(event.callId).catch(() => undefined);
      }
      this.options.log("whatsapp_call_start_failed", {connectorKey: this.options.connectorKey, callId: event.callId, message: safeMessage(error)});
    }).finally(() => {
      this.pending.delete(event.callId);
      if (!this.active.has(event.callId)) processCallSlots.delete(slotKey);
    });
    this.pending.set(event.callId, {abort, promise});
  }

  async handle(control: WhatsAppCallControlRecord): Promise<Record<string, unknown>> {
    const active = this.active.get(control.callId);
    if (!active || active.sessionId !== control.sessionId || active.agentKey !== control.agentKey) throw new Error(controlError("call_unavailable", "No matching active WhatsApp call is connected."));
    if (!(await this.authorizationMatches(active.actorId, active.authorization, active.sessionId))) {
      await this.stopCall(active.callId, "authorization_revoked", true);
      throw new Error(controlError("authorization_revoked", "WhatsApp call authorization was revoked."));
    }
    if (control.operation === "hangup") {
      if (control.voiceTurnId) {
        const turn = await this.options.voice.getTurn(control.voiceTurnId);
        if (!isActiveLiveVoiceTurn(turn) || turn.liveVoiceSessionId !== active.liveVoiceSessionId) throw new Error(controlError("voice_turn_conflict", "The WhatsApp voice turn is not active in this call."));
        await this.options.voice.completeTurn(turn.id, "Ended the WhatsApp call.");
      }
      const result = this.result(active, "disconnected");
      await this.stopCall(active.callId, "requested", true);
      return result;
    }
    if (!control.text || !control.mode) throw new Error(controlError("invalid_input", "WhatsApp call send requires text and mode."));
    try {
      const delivered = await active.call.deliver({controlId: control.id, text: control.text, mode: control.mode, ...(control.voiceTurnId ? {liveVoiceTurnId: control.voiceTurnId} : {})});
      return {...this.result(active, "connected"), state: "sent", mode: control.mode, delivery: delivered.delivery, ...(delivered.turn ? {voiceTurnId: delivered.turn.id} : {})};
    } catch (error) {
      const code = safeMessage(error) === "voice_turn_conflict" ? "voice_turn_conflict" : "provider_unavailable";
      throw new Error(controlError(code, code === "voice_turn_conflict" ? "The WhatsApp voice turn is no longer active." : "GPT-Live is not ready to accept call context."));
    }
  }

  status(): Record<string, unknown>[] { return [...this.active.values()].map((call) => this.result(call, "connected")); }

  private async startCall(event: WhatsAppCallEvent, abort: AbortController, slotKey: string): Promise<void> {
    if (this.stopped) return;
    const timestamp = eventTimestamp(event.timestamp);
    if (timestamp === null || Math.abs(Date.now() - timestamp) > EVENT_MAX_AGE_MS) throw new Error("WhatsApp call event timestamp is invalid or stale.");
    if (!isLiveVoiceEnabled(this.options.env)) { await this.reject(event.callId, abort.signal); return; }
    const caller = actorId(event);
    const authorization = await this.options.authorizer.authorizeActor({connectorKey: this.options.connectorKey, externalActorId: caller});
    if (!authorization.authorized || authorization.agentKey !== this.options.accountAgentKey) { await this.reject(event.callId, abort.signal); return; }
    const binding = await this.options.conversations.getConversationBinding({source: WHATSAPP_SOURCE, connectorKey: this.options.connectorKey, externalConversationId: caller});
    if (!binding || !bindingMatchesAuthorization(binding.metadata, authorization)) { await this.reject(event.callId, abort.signal); return; }
    const session = await this.options.sessions.getSession(binding.sessionId);
    if (session.archivedAt || session.agentKey !== authorization.agentKey) { await this.reject(event.callId, abort.signal); return; }
    const provider = this.options.createProvider?.() ?? createOpenAILiveVoiceProvider({env: this.options.env, log: this.options.log});
    const selectedVoice = await resolveLiveVoiceSelection({agentKey: session.agentKey, agents: this.options.agents, provider});
    const startupSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(STARTUP_TIMEOUT_MS)]);
    let peer: WhatsAppCallPeerLike | undefined;
    let liveCall: LiveVoiceCall | undefined;
    let liveVoiceSessionId: string | undefined;
    let accepted = false;
    let preAccepted = false;
    let capture: WhatsAppCallCapture | undefined;
    let activated = false;
    try {
      startupSignal.throwIfAborted();
      peer = await (this.options.createPeer ?? WhatsAppCallPeer.create)({
        onAudio: (audio) => capture?.push(audio),
        onFailure: (error) => { if (activated) void this.stopCall(event.callId, "media_failed", true); else abort.abort(error); },
      });
      const answerSdp = await abortableStartup(peer.answer(event.offerSdp!, startupSignal), startupSignal);
      await this.options.meta.preAccept(event.callId, answerSdp, startupSignal); preAccepted = true;
      await peer.waitUntilConnected(startupSignal);
      const output = new WhatsAppCallOutput(peer);
      const prepared = await prepareLiveVoiceCall({
        source: WHATSAPP_SOURCE, connectorKey: this.options.connectorKey, scopeKey: event.callId, roomKey: event.callId,
        sessionId: session.id, agentKey: session.agentKey, transportContext: {phoneNumberId: this.options.phoneNumberId},
        instructions: renderLiveVoiceProviderInstructions({transport: "WhatsApp"}), provider, agents: this.options.agents,
        resolvedVoice: selectedVoice,
        voice: this.options.voice, output,
        log: (name, payload) => this.options.log(name, {connectorKey: this.options.connectorKey, callId: event.callId, ...payload}),
        authorizeDelegation: () => this.authorizationMatches(caller, authorization, session.id),
        onTerminalFailure: (reason) => { void this.stopCall(event.callId, reason, true); },
      });
      liveCall = prepared.call;
      liveVoiceSessionId = prepared.sessionRecord.id;
      capture = new WhatsAppCallCapture({
        actorId: "caller",
        identityId: authorization.identityId,
        transportAuthorization: {
          identityId: authorization.identityId,
          agentKey: authorization.agentKey,
          actorBindingId: authorization.actorBindingId,
          authorizationVersion: authorization.authorizationVersion,
        },
        getCall: () => liveCall,
      });
      await liveCall.start(startupSignal);
      if (!(await this.authorizationMatches(caller, authorization, session.id))) throw new Error("WhatsApp call authorization was revoked during startup.");
      await this.options.meta.accept(event.callId, answerSdp, startupSignal); accepted = true;
      if (!(await this.authorizationMatches(caller, authorization, session.id))) throw new Error("WhatsApp call authorization was revoked during acceptance.");
      await this.options.voice.upsertSession({...prepared.sessionRecord, state: "connected"});
      peer.startOutput();
      startupSignal.throwIfAborted();
      const expiry = setTimeout(() => { void this.stopCall(event.callId, "session_expired", true); }, SESSION_TTL_MS); expiry.unref?.();
      const active: ActiveCall = {
        callId: event.callId, sessionId: session.id, agentKey: session.agentKey,
        liveVoiceSessionId: prepared.sessionRecord.id, call: liveCall, peer, capture, expiry,
        health: setInterval(() => {
          if (active.healthBusy) return;
          active.healthBusy = true;
          void this.persistHealth(event.callId)
            .catch((error: unknown) => this.options.log("whatsapp_call_health_persist_failed", {connectorKey: this.options.connectorKey, callId: event.callId, message: safeMessage(error)}))
            .finally(() => { active.healthBusy = false; });
        }, 10_000), healthBusy: false, closing: false,
        model: prepared.provider.model, voice: prepared.voice, slotKey,
        actorId: caller, authorization,
      };
      active.health.unref?.(); this.active.set(event.callId, active); activated = true;
      await this.persistHealth(event.callId).catch((error: unknown) => this.options.log("whatsapp_call_health_persist_failed", {connectorKey: this.options.connectorKey, callId: event.callId, message: safeMessage(error)}));
      this.options.log("whatsapp_call_connected", {connectorKey: this.options.connectorKey, callId: event.callId, sessionId: session.id, model: active.model, voice: active.voice});
    } catch (error) {
      if (liveCall) await liveCall.close("startup_failed").catch(() => undefined);
      peer?.close();
      if (liveVoiceSessionId) await this.options.voice.markSessionDisconnected(liveVoiceSessionId, "error", "startup_failed").catch(() => undefined);
      if (preAccepted) await this.options.meta.terminate(event.callId).catch(() => undefined);
      else if (!accepted) await this.options.meta.reject(event.callId).catch(() => undefined);
      this.rememberFinished(event.callId);
      throw error;
    }
  }

  private async stopCall(callId: string, reason: string, signalMeta: boolean): Promise<void> {
    const active = this.active.get(callId);
    if (!active || active.closing) return;
    active.closing = true; this.active.delete(callId); clearTimeout(active.expiry); clearInterval(active.health);
    processCallSlots.delete(active.slotKey);
    active.capture.close(); await active.call.close(reason).catch(() => undefined); active.peer.close();
    await this.options.voice.markSessionDisconnected(active.liveVoiceSessionId, reason === "media_failed" ? "error" : "disconnected", reason).catch(() => undefined);
    if (signalMeta) await this.options.meta.terminate(callId).catch((error: unknown) => this.options.log("whatsapp_call_terminate_failed", {connectorKey: this.options.connectorKey, callId, message: safeMessage(error)}));
    this.rememberFinished(callId);
    this.options.log("whatsapp_call_disconnected", {connectorKey: this.options.connectorKey, callId, sessionId: active.sessionId, reason});
  }

  private async persistHealth(callId: string): Promise<void> {
    const active = this.active.get(callId);
    if (!active || active.closing) return;
    if (!(await this.authorizationMatches(active.actorId, active.authorization, active.sessionId))) {
      await this.stopCall(active.callId, "authorization_revoked", true);
      return;
    }
    const call = active.call.getSnapshot();
    const peer = active.peer.snapshot();
    const health = call.connected && peer.state === "connected" ? "ready" : call.recovering ? "recovering" : "degraded";
    const reasons = [...(!call.connected ? ["provider_unavailable" as const] : []), ...(peer.state !== "connected" ? ["transport_not_ready" as const] : [])];
    await this.options.voice.updateSessionHealth({id: active.liveVoiceSessionId, health, reasons, observedAt: Date.now(), diagnostics: {call, transport: peer}});
  }

  private async reject(callId: string, signal: AbortSignal): Promise<void> {
    await this.options.meta.reject(callId, signal);
    this.rememberFinished(callId);
  }

  private rejectOverflow(callId: string): void {
    if (this.overflowRejections.size >= MAX_PENDING_OVERFLOW_REJECTIONS) {
      this.options.log("whatsapp_call_overflow_reject_dropped", {connectorKey: this.options.connectorKey, callId});
      return;
    }
    const pending = this.options.meta.reject(callId)
      .catch((error: unknown) => this.options.log("whatsapp_call_reject_failed", {connectorKey: this.options.connectorKey, callId, message: safeMessage(error)}))
      .finally(() => { this.overflowRejections.delete(callId); });
    this.overflowRejections.set(callId, pending);
  }

  private async authorizationMatches(actor: string, admitted: AuthorizedWhatsAppActor, sessionId: string): Promise<boolean> {
    const current = await this.options.authorizer.authorizeActor({connectorKey: this.options.connectorKey, externalActorId: actor});
    if (!current.authorized || !sameWhatsAppAuthorization(current, admitted)) return false;
    const binding = await this.options.conversations.getConversationBinding({source: WHATSAPP_SOURCE, connectorKey: this.options.connectorKey, externalConversationId: actor});
    if (!binding || binding.sessionId !== sessionId || !bindingMatchesAuthorization(binding.metadata, current)) return false;
    const session = await this.options.sessions.getSession(sessionId);
    return !session.archivedAt && session.agentKey === current.agentKey;
  }

  private result(active: ActiveCall, state: "connected" | "disconnected"): Record<string, unknown> {
    return {ok: true, state, connectorKey: this.options.connectorKey, callId: active.callId, sessionId: active.sessionId, voiceSessionId: active.liveVoiceSessionId, model: active.model, voice: active.voice};
  }

  private isRecentlyFinished(callId: string): boolean {
    const cutoff = Date.now() - EVENT_MAX_AGE_MS;
    for (const [id, at] of this.recentlyFinished) if (at < cutoff) this.recentlyFinished.delete(id);
    return this.recentlyFinished.has(callId);
  }

  private rememberFinished(callId: string): void {
    this.recentlyFinished.delete(callId);
    this.recentlyFinished.set(callId, Date.now());
    while (this.recentlyFinished.size > MAX_RECENTLY_FINISHED) {
      const oldest = this.recentlyFinished.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentlyFinished.delete(oldest);
    }
  }

  private allowConnectEvent(actor: string, now: number): boolean {
    const cutoff = now - 60_000;
    if (now - this.connectEventWindowAt >= 60_000) {
      this.connectEventWindowAt = now;
      this.connectEventsInWindow = 0;
      this.actorConnectEvents.clear();
    }
    let timestamps = this.actorConnectEvents.get(actor)?.filter((timestamp) => timestamp > cutoff);
    if (timestamps?.length === 0) { this.actorConnectEvents.delete(actor); timestamps = undefined; }
    if (!timestamps) {
      if (this.actorConnectEvents.size >= MAX_RATE_LIMITED_ACTORS) return false;
      timestamps = [];
    }
    if (timestamps.length >= MAX_CONNECT_EVENTS_PER_ACTOR_PER_MINUTE) return false;
    if (this.connectEventsInWindow >= MAX_CONNECT_EVENTS_PER_CONNECTOR_PER_MINUTE) return false;
    timestamps.push(now);
    this.actorConnectEvents.set(actor, timestamps);
    this.connectEventsInWindow += 1;
    return true;
  }
}

export class WhatsAppCallControlWorker {
  private readonly drain: DrainLoop;
  constructor(private readonly input: {connectorKey: string; controls: WhatsAppCallControlRepo; manager: WhatsAppCallManager; log(event: string, payload: Record<string, unknown>): void}) {
    this.drain = new DrainLoop({label: `WhatsApp call controls ${input.connectorKey}`, pollIntervalMs: 5_000, drain: () => this.drainOnce(), onError: (error) => input.log("whatsapp_call_control_drain_failed", {connectorKey: input.connectorKey, message: safeMessage(error)})});
  }
  async start(): Promise<void> { await this.input.manager.start(); this.drain.start(); await this.drain.trigger(); }
  async stop(): Promise<void> { await this.drain.stop(); await this.input.manager.stop(); }
  triggerDrain(): Promise<void> { return this.drain.trigger(); }
  private async drainOnce(): Promise<void> {
    while (!this.drain.isStopped) {
      const control = await this.input.controls.claimNextControl(this.input.connectorKey);
      if (!control) return;
      try { await this.input.controls.completeControl(control.id, await this.input.manager.handle(control) as never); }
      catch (error) { const value = safeMessage(error); await this.input.controls.failControl(control.id, value.startsWith("{") ? value : controlError("worker_failed", value)); }
    }
  }
}
