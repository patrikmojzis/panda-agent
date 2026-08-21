import {afterEach, describe, expect, it, vi} from "vitest";

import type {ConnectorAccountRecord} from "../src/domain/connectors/types.js";
import {
  WhatsAppLinkManager,
  type WhatsAppLinkService,
} from "../src/integrations/channels/whatsapp/link-manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function account(overrides: Partial<ConnectorAccountRecord> = {}): ConnectorAccountRecord {
  return {
    id: "f8621aab-6315-4a2f-8f4a-d7c67afe0068",
    source: "whatsapp",
    accountKey: "main",
    connectorKey: "f8621aab-6315-4a2f-8f4a-d7c67afe0068",
    status: "disabled",
    ownerKind: "agent",
    ownerAgentKey: "luna",
    ownerIdentityId: null,
    config: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function harness() {
  const pairing = deferred<{
    connectorKey: string;
    registered: boolean;
    accountId: string;
    alreadyPaired: boolean;
    name?: string;
  }>();
  let onPairingCode: ((code: string) => void) | undefined;
  let onPromotionStart: (() => void) | undefined;
  const service: WhatsAppLinkService = {
    pair: vi.fn(async (_phoneNumber, handler, promotionHandler) => {
      onPairingCode = handler;
      onPromotionStart = promotionHandler;
      return pairing.promise;
    }),
    stop: vi.fn(async () => {}),
  };
  const manager = new WhatsAppLinkManager({
    createService: () => service,
    timeoutMs: 100,
    terminalRetentionMs: 1_000,
  });
  return {
    manager,
    pairing,
    service,
    emitCode: (code: string) => onPairingCode?.(code),
    beginPromotion: () => onPromotionStart?.(),
  };
}

describe("WhatsAppLinkManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the pairing code in memory and promotes the account after linking", async () => {
    const target = account();
    const test = harness();

    const started = test.manager.start(target, "421900000000");
    await Promise.resolve();
    test.emitCode("ABCD-EFGH");

    expect(test.service.pair).toHaveBeenCalledWith(
      "421900000000",
      expect.any(Function),
      expect.any(Function),
    );
    expect(test.manager.get(target.id, started.attemptId)).toMatchObject({
      state: "awaiting_confirmation",
      pairingCode: "ABCD-EFGH",
    });

    test.beginPromotion();
    test.pairing.resolve({
      connectorKey: target.connectorKey,
      registered: true,
      accountId: "246664333885442@lid",
      name: "Panda",
      alreadyPaired: false,
    });

    await vi.waitFor(() => {
      expect(test.manager.get(target.id, started.attemptId)).toMatchObject({
        state: "linked",
        providerAccountId: "246664333885442@lid",
      });
    });
    expect(test.manager.get(target.id, started.attemptId)).not.toHaveProperty("pairingCode");
    expect(test.manager.getActive(target.id)).toBeNull();
  });

  it("rejects a concurrent attempt for the same account", () => {
    const target = account();
    const test = harness();
    test.manager.start(target, "421900000000");

    expect(() => test.manager.start(target, "421900000001")).toThrow(
      "already has an active link attempt",
    );
  });

  it("closes the promotion gate when an attempt is cancelled", async () => {
    const target = account();
    const test = harness();
    const started = test.manager.start(target, "421900000000");

    await test.manager.cancel(target.id, started.attemptId);

    expect(() => test.beginPromotion()).toThrow("cancelled before auth promotion");
    expect(test.manager.get(target.id, started.attemptId)).toMatchObject({state: "cancelled"});
    expect(test.manager.getActive(target.id)).toBeNull();
  });

  it("cannot report cancellation after auth promotion has started", async () => {
    const target = account();
    const test = harness();
    const started = test.manager.start(target, "421900000000");
    await Promise.resolve();
    test.emitCode("ABCD-EFGH");
    test.beginPromotion();

    await expect(test.manager.cancel(target.id, started.attemptId))
      .rejects.toThrow("already committing auth");
    test.pairing.resolve({
      connectorKey: target.connectorKey,
      registered: true,
      accountId: "246664333885442@lid",
      alreadyPaired: false,
    });
    await vi.waitFor(() => {
      expect(test.manager.get(target.id, started.attemptId)).toMatchObject({state: "linked"});
    });
  });

  it("requires reset before relinking an account with a stored provider identity", () => {
    const test = harness();
    expect(() => test.manager.start(account({externalAccountId: "421900000000@s.whatsapp.net"}), "421900000000"))
      .toThrow("Reset WhatsApp account main");
    expect(test.service.pair).not.toHaveBeenCalled();
  });

  it("expires and stops an abandoned link attempt", async () => {
    vi.useFakeTimers();
    const target = account();
    const test = harness();
    const started = test.manager.start(target, "421900000000");

    await vi.advanceTimersByTimeAsync(100);

    expect(test.manager.get(target.id, started.attemptId)).toMatchObject({state: "expired"});
    expect(test.manager.get(target.id, started.attemptId)).not.toHaveProperty("pairingCode");
    expect(test.service.stop).toHaveBeenCalledOnce();
    expect(test.manager.getActive(target.id)).toBeNull();
  });

  it("cancels active in-memory attempts during daemon shutdown", async () => {
    const target = account();
    const test = harness();
    const started = test.manager.start(target, "421900000000");

    await test.manager.stop();

    expect(test.service.stop).toHaveBeenCalledOnce();
    expect(test.manager.get(target.id, started.attemptId)).toBeNull();
    expect(test.manager.getActive(target.id)).toBeNull();
  });
});
