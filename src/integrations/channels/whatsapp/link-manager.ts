import {randomUUID} from "node:crypto";

import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {WhatsAppPairResult} from "./account.js";

export type WhatsAppLinkAttemptState =
  | "starting"
  | "awaiting_confirmation"
  | "linked"
  | "failed"
  | "cancelled"
  | "expired";

export interface WhatsAppLinkAttempt {
  attemptId: string;
  accountId: string;
  accountKey: string;
  state: WhatsAppLinkAttemptState;
  pairingCode?: string;
  providerAccountId?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface WhatsAppLinkService {
  pair(
    phoneNumber: string,
    onPairingCode?: (code: string) => void,
    onPromotionStart?: () => void,
  ): Promise<WhatsAppPairResult>;
  stop(): Promise<void>;
}

export interface WhatsAppLinkManagerOptions {
  createService(account: ConnectorAccountRecord): WhatsAppLinkService;
  timeoutMs?: number;
  terminalRetentionMs?: number;
  now?: () => number;
}

interface ActiveAttempt {
  record: WhatsAppLinkAttempt;
  service: WhatsAppLinkService;
  timer: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  completion?: Promise<void>;
  promotionStarted: boolean;
}

const DEFAULT_LINK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 10 * 60_000;

function publicAttempt(attempt: WhatsAppLinkAttempt): WhatsAppLinkAttempt {
  return {...attempt};
}

export class WhatsAppLinkManager {
  private readonly createService: WhatsAppLinkManagerOptions["createService"];
  private readonly timeoutMs: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => number;
  private readonly attempts = new Map<string, ActiveAttempt>();
  private readonly attemptIdByAccountId = new Map<string, string>();

  constructor(options: WhatsAppLinkManagerOptions) {
    this.createService = options.createService;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LINK_TIMEOUT_MS;
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  start(account: ConnectorAccountRecord, phoneNumber: string): WhatsAppLinkAttempt {
    if (account.status === "enabled") {
      throw new Error(`Disable WhatsApp account ${account.accountKey} before linking it.`);
    }
    if (account.externalAccountId) {
      throw new Error(`Reset WhatsApp account ${account.accountKey} before starting a new pairing attempt.`);
    }
    const activeId = this.attemptIdByAccountId.get(account.id);
    if (activeId) {
      const active = this.attempts.get(activeId);
      if (active && ["starting", "awaiting_confirmation"].includes(active.record.state)) {
        throw new Error(`WhatsApp account ${account.accountKey} already has an active link attempt.`);
      }
    }

    const createdAt = this.now();
    const attemptId = randomUUID();
    const service = this.createService(account);
    const record: WhatsAppLinkAttempt = {
      attemptId,
      accountId: account.id,
      accountKey: account.accountKey,
      state: "starting",
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
      updatedAt: createdAt,
    };
    const timer = setTimeout(() => {
      void this.finish(attemptId, "expired");
    }, this.timeoutMs);
    timer.unref?.();
    const activeAttempt: ActiveAttempt = {record, service, timer, promotionStarted: false};
    this.attempts.set(attemptId, activeAttempt);
    this.attemptIdByAccountId.set(account.id, attemptId);

    activeAttempt.completion = service.pair(phoneNumber, (pairingCode) => {
      const active = this.attempts.get(attemptId);
      if (!active || !["starting", "awaiting_confirmation"].includes(active.record.state)) return;
      this.update(attemptId, {
        state: "awaiting_confirmation",
        pairingCode,
      });
    }, () => {
      const active = this.attempts.get(attemptId);
      if (!active || !["starting", "awaiting_confirmation"].includes(active.record.state)) {
        throw new Error(`WhatsApp link attempt ${attemptId} was cancelled before auth promotion.`);
      }
      active.promotionStarted = true;
      clearTimeout(active.timer);
    }).then(async (result) => {
      const active = this.attempts.get(attemptId);
      if (!active || !["starting", "awaiting_confirmation"].includes(active.record.state)) return;
      if (!result.accountId) throw new Error("WhatsApp linking completed without an account identity.");
      this.update(attemptId, {
        state: "linked",
        pairingCode: undefined,
        providerAccountId: result.accountId,
      });
      await this.release(attemptId);
    }).catch(async (error) => {
      const active = this.attempts.get(attemptId);
      if (!active || active.record.state === "cancelled" || active.record.state === "expired") return;
      this.update(attemptId, {
        state: "failed",
        pairingCode: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.release(attemptId);
    });

    return publicAttempt(record);
  }

  get(accountId: string, attemptId: string): WhatsAppLinkAttempt | null {
    const attempt = this.attempts.get(attemptId)?.record;
    return attempt?.accountId === accountId ? publicAttempt(attempt) : null;
  }

  getActive(accountId: string): WhatsAppLinkAttempt | null {
    const attemptId = this.attemptIdByAccountId.get(accountId);
    return attemptId ? this.get(accountId, attemptId) : null;
  }

  async cancel(accountId: string, attemptId: string): Promise<WhatsAppLinkAttempt> {
    const active = this.attempts.get(attemptId);
    if (!active || active.record.accountId !== accountId) throw new Error("WhatsApp link attempt was not found.");
    if (active.record.state === "starting" || active.record.state === "awaiting_confirmation") {
      if (active.promotionStarted) {
        throw new Error("WhatsApp link attempt is already committing auth and can no longer be cancelled.");
      }
      await this.finish(attemptId, "cancelled");
    }
    return publicAttempt(active.record);
  }

  async stop(): Promise<void> {
    const activeAttempts = [...this.attempts.entries()];
    for (const [attemptId, active] of activeAttempts) {
      clearTimeout(active.timer);
      if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
      if (!active.promotionStarted && ["starting", "awaiting_confirmation"].includes(active.record.state)) {
        this.update(attemptId, {state: "cancelled", pairingCode: undefined});
      }
    }
    await Promise.allSettled(activeAttempts
      .filter(([, active]) => !active.promotionStarted)
      .map(([, active]) => active.service.stop()));
    await Promise.allSettled(activeAttempts
      .filter(([, active]) => active.promotionStarted && active.completion)
      .map(([, active]) => active.completion!));
    for (const [, active] of activeAttempts) {
      if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
    }
    this.attemptIdByAccountId.clear();
    this.attempts.clear();
  }

  private update(attemptId: string, input: Partial<Pick<WhatsAppLinkAttempt, "state" | "pairingCode" | "providerAccountId" | "error">>): void {
    const active = this.attempts.get(attemptId);
    if (!active) return;
    Object.assign(active.record, input, {updatedAt: this.now()});
    if (input.pairingCode === undefined && "pairingCode" in input) delete active.record.pairingCode;
  }

  private async finish(attemptId: string, state: "cancelled" | "expired"): Promise<void> {
    const active = this.attempts.get(attemptId);
    if (!active || active.promotionStarted) return;
    this.update(attemptId, {state, pairingCode: undefined});
    await this.release(attemptId);
  }

  private async release(attemptId: string): Promise<void> {
    const active = this.attempts.get(attemptId);
    if (!active) return;
    clearTimeout(active.timer);
    if (this.attemptIdByAccountId.get(active.record.accountId) === attemptId) {
      this.attemptIdByAccountId.delete(active.record.accountId);
    }
    await active.service.stop().catch(() => undefined);
    if (!active.cleanupTimer) {
      active.cleanupTimer = setTimeout(() => {
        this.attempts.delete(attemptId);
      }, this.terminalRetentionMs);
      active.cleanupTimer.unref?.();
    }
  }
}
