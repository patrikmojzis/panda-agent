import {PostgresAgentStore} from "../../../../domain/agents/postgres.js";
import {acquireManagedConnectorLease, PostgresConnectorLeaseRepo, type ManagedConnectorLease} from "../../../../domain/connector-leases/repo.js";
import {PostgresConnectorAccountStore} from "../../../../domain/connectors/postgres.js";
import type {ConnectorAccountRecord} from "../../../../domain/connectors/types.js";
import {LiveVoiceRepo} from "../../../../domain/live-voice/repo.js";
import {PostgresSessionStore} from "../../../../domain/sessions/postgres.js";
import {ConversationRepo} from "../../../../domain/sessions/conversations/repo.js";
import type {SecretCrypto} from "../../../../domain/secrets/crypto.js";
import type {ConnectorDaemonRuntimeHandle, ConnectorWorkerRuntimeNotificationRegistration} from "../../worker-runtime.js";
import {isLiveVoiceEnabled} from "../../../voice/config.js";
import {createWhatsAppActorAuthorizer} from "../authorization.js";
import {WHATSAPP_SOURCE} from "../config.js";
import {parseWhatsAppMetaCallingConfig} from "./config.js";
import {WhatsAppCallControlWorker, WhatsAppCallManager} from "./manager.js";
import {WhatsAppMetaCallClient} from "./meta-client.js";
import {WhatsAppCallControlRepo} from "./postgres.js";
import type {WhatsAppCallWebhookServer} from "./webhook.js";
import {WHATSAPP_META_ACCESS_TOKEN_SECRET, WHATSAPP_META_APP_SECRET, WHATSAPP_META_VERIFY_TOKEN_SECRET} from "./types.js";

export interface MetaCloudWhatsAppCallServiceOptions {
  account: ConnectorAccountRecord;
  crypto: SecretCrypto;
  runtime: ConnectorDaemonRuntimeHandle;
  webhook: WhatsAppCallWebhookServer;
  env?: NodeJS.ProcessEnv;
  log(event: string, payload: Record<string, unknown>): void;
}

/** Runs one official Meta Cloud Calling connector without touching Baileys. */
export class MetaCloudWhatsAppCallService {
  private lease?: ManagedConnectorLease;
  private notification?: ConnectorWorkerRuntimeNotificationRegistration;
  private unregisterWebhook?: () => void;
  private worker?: WhatsAppCallControlWorker;
  private stopping = false;
  private runPromise?: Promise<void>;
  private resolveStopped?: () => void;
  private readonly stopped = new Promise<void>((resolve) => { this.resolveStopped = resolve; });

  constructor(private readonly options: MetaCloudWhatsAppCallServiceOptions) {}

  async run(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    if (this.stopping) return;
    const promise = this.runInternal();
    this.runPromise = promise;
    try { await promise; }
    finally { if (this.runPromise === promise) this.runPromise = undefined; }
  }

  private async runInternal(): Promise<void> {
    const config = parseWhatsAppMetaCallingConfig(this.options.account);
    if (!config) throw new Error(`WhatsApp account ${this.options.account.accountKey} is not configured for Meta Cloud Calling.`);
    if (this.options.account.ownerKind !== "agent" || !this.options.account.ownerAgentKey) throw new Error(`WhatsApp account ${this.options.account.accountKey} must be owned by an agent.`);
    const accounts = new PostgresConnectorAccountStore({pool: this.options.runtime.pool});
    const [accessToken, appSecret, verifyToken] = await Promise.all([
      accounts.getSecret(this.options.account.id, WHATSAPP_META_ACCESS_TOKEN_SECRET, this.options.crypto),
      accounts.getSecret(this.options.account.id, WHATSAPP_META_APP_SECRET, this.options.crypto),
      accounts.getSecret(this.options.account.id, WHATSAPP_META_VERIFY_TOKEN_SECRET, this.options.crypto),
    ]);
    if (!accessToken || !appSecret || !verifyToken) throw new Error(`WhatsApp account ${this.options.account.accountKey} is missing Meta Cloud Calling credentials.`);
    if (this.stopping) return;
    const controls = new WhatsAppCallControlRepo(this.options.runtime.pool);
    const manager = new WhatsAppCallManager({
      connectorKey: this.options.account.connectorKey,
      accountAgentKey: this.options.account.ownerAgentKey,
      phoneNumberId: config.calling.phoneNumberId,
      env: this.options.env ?? process.env,
      meta: new WhatsAppMetaCallClient({accessToken, graphVersion: config.calling.graphVersion, phoneNumberId: config.calling.phoneNumberId}),
      controls,
      voice: new LiveVoiceRepo({pool: this.options.runtime.pool}),
      agents: new PostgresAgentStore({pool: this.options.runtime.pool}),
      sessions: new PostgresSessionStore({pool: this.options.runtime.pool}),
      conversations: new ConversationRepo({pool: this.options.runtime.pool}),
      authorizer: createWhatsAppActorAuthorizer({pool: this.options.runtime.pool}),
      log: this.options.log,
    });
    this.worker = new WhatsAppCallControlWorker({connectorKey: this.options.account.connectorKey, controls, manager, log: this.options.log});
    const noOp = {triggerDrain: async () => undefined};
    try {
      this.lease = await acquireManagedConnectorLease({
        repo: new PostgresConnectorLeaseRepo({pool: this.options.runtime.pool}), source: WHATSAPP_SOURCE,
        connectorKey: this.options.account.connectorKey,
        alreadyHeldMessage: `WhatsApp connector ${this.options.account.connectorKey} is already running.`,
        onLeaseLost: async (error) => { this.options.log("connector_lease_lost", {connectorKey: this.options.account.connectorKey, message: error.message}); this.requestStop(); },
      });
      if (this.stopping) return;
      await this.worker.start();
      if (this.stopping) return;
      this.notification = this.options.runtime.notifications.register({connectorKey: this.options.account.connectorKey, outboundWorker: noOp, actionWorker: noOp, additionalTargets: {whatsapp_call: this.worker}});
      this.unregisterWebhook = this.options.webhook.register({phoneNumberId: config.calling.phoneNumberId, appSecret, verifyToken, onEvent: (event) => manager.onEvent(event)});
      await this.options.webhook.start();
      if (this.stopping) return;
      this.options.log("whatsapp_call_worker_started", {connectorKey: this.options.account.connectorKey, phoneNumberId: config.calling.phoneNumberId, voiceEnabled: isLiveVoiceEnabled(this.options.env ?? process.env)});
      await this.stopped;
    } finally {
      this.stopping = true;
      this.resolveStopped?.();
      await this.cleanup();
    }
  }

  async stop(): Promise<void> {
    this.requestStop();
    const running = this.runPromise;
    if (running) await running;
  }

  private async cleanup(): Promise<void> {
    this.unregisterWebhook?.(); this.unregisterWebhook = undefined;
    this.notification?.unregister(); this.notification = undefined;
    const worker = this.worker; this.worker = undefined;
    const lease = this.lease; this.lease = undefined;
    await worker?.stop().catch(() => undefined);
    await lease?.release().catch(() => undefined);
  }

  private requestStop(): void {
    this.stopping = true;
    this.resolveStopped?.();
  }
}
