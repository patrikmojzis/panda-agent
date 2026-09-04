import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresChannelActionStore} from "../../src/domain/channels/actions/postgres.js";
import {ChannelActionWorker} from "../../src/domain/channels/actions/worker.js";
import {PostgresOutboundDeliveryStore} from "../../src/domain/channels/deliveries/postgres.js";
import {ChannelOutboundDeliveryWorker} from "../../src/domain/channels/deliveries/worker.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe.sequential("channel receipt ownership with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let deliveries: PostgresOutboundDeliveryStore;
  let actions: PostgresChannelActionStore;
  const legacyDeliveryId = randomUUID();
  const legacyActionId = randomUUID();

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/channel-receipts-live-test", max: 3});
    const index = PANDA_SCHEMA_MIGRATIONS.findIndex(({id}) => id === "0020_channel_receipt_ownership");
    if (index < 0) throw new Error("Channel receipt migration is missing from the catalog.");
    const migrate = (count: number) => createPostgresMigrator({
      pool, migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
      schemaName: "runtime", tableName: "schema_migrations", lockName: "panda:channel-receipts-live-test",
    }).migrate();
    await migrate(index);
    await pool.query(`
      INSERT INTO runtime.outbound_deliveries (
        id,channel,connector_key,external_conversation_id,items,status,attempt_count,claimed_at
      ) VALUES ($1,'telegram','legacy','chat','[{"type":"text","text":"already attempted"}]','sending',1,NOW());
    `, [legacyDeliveryId]);
    await pool.query(`
      INSERT INTO runtime.channel_actions (id,channel,connector_key,kind,payload,status,attempt_count,claimed_at,expires_at)
      VALUES ($1,'telegram','legacy','telegram_reaction','{"conversationId":"chat","messageId":"message","emoji":"✅"}','sending',1,NOW(),NOW() - INTERVAL '1 minute');
    `, [legacyActionId]);
    await migrate(PANDA_SCHEMA_MIGRATIONS.length);
    deliveries = new PostgresOutboundDeliveryStore({pool});
    actions = new PostgresChannelActionStore({pool});
  });

  afterAll(async () => { await pool?.end(); });

  const enqueueDelivery = (connectorKey: string) => deliveries.enqueueDelivery({
    channel: "telegram", target: {source: "telegram", connectorKey, externalConversationId: "chat"},
    items: [{type: "text", text: "hello"}],
  });
  const enqueueAction = (connectorKey: string) => actions.enqueueAction({
    channel: "telegram", connectorKey, kind: "telegram_reaction",
    payload: {conversationId: "chat", messageId: "message", emoji: "✅"},
  });

  liveIt("adds ownership without inventing legacy claims or changing historical outcomes", async () => {
    expect(await deliveries.getDelivery(legacyDeliveryId)).toMatchObject({status: "sending", attemptCount: 1, claimToken: undefined});
    expect(await actions.getAction(legacyActionId)).toMatchObject({status: "sending", attemptCount: 1, claimToken: undefined});
  });

  liveIt("startup preserves tokenless interrupted work as unknown without replay or expiry claims", async () => {
    const send = vi.fn();
    const dispatch = vi.fn();
    const deliveryWorker = new ChannelOutboundDeliveryWorker({store: deliveries, adapter: {channel: "telegram", send}, connectorKey: "legacy"});
    const actionWorker = new ChannelActionWorker({store: actions, lookup: {channel: "telegram", connectorKey: "legacy"}, dispatch});
    await deliveryWorker.start({subscribeToNotifications: false});
    await actionWorker.start({subscribeToNotifications: false});
    await Promise.all([deliveryWorker.triggerDrain(), actionWorker.triggerDrain()]);
    await Promise.all([deliveryWorker.stop(), actionWorker.stop()]);
    expect(await deliveries.getDelivery(legacyDeliveryId)).toMatchObject({status: "unknown", attemptCount: 1});
    expect(await actions.getAction(legacyActionId)).toMatchObject({status: "unknown", attemptCount: 1});
    expect(send).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  liveIt("fences delivery receipts and preserves immutable sent success", async () => {
    const lookup = {channel: "telegram", connectorKey: "delivery-fence"};
    const delivery = await enqueueDelivery(lookup.connectorKey);
    const claims = await Promise.all([
      deliveries.claimNextPendingDelivery(lookup),
      new PostgresOutboundDeliveryStore({pool}).claimNextPendingDelivery(lookup),
    ]);
    const claimed = claims.find((claim) => claim?.id === delivery.id)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claimed.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    await expect(deliveries.markDeliverySent({id: delivery.id, claimToken: randomUUID(), sent: []})).rejects.toThrow("no longer owns");
    const complete = {id: delivery.id, claimToken: claimed.claimToken!, sent: [{type: "text" as const, externalMessageId: "sent-once"}]};
    await deliveries.markDeliverySent(complete);
    await deliveries.markDeliverySent(complete);
    await expect(deliveries.markDeliveryFailed({id: delivery.id, claimToken: claimed.claimToken!, error: "late failure"})).rejects.toThrow("no longer owns");
    await deliveries.markDeliveryUnknown({id: delivery.id, claimToken: claimed.claimToken!, error: "late ambiguity"});
    expect(await deliveries.getDelivery(delivery.id)).toMatchObject({status: "sent", sent: complete.sent, lastError: undefined, attemptCount: 1});
  });

  liveIt("fences action receipts and expiry without rewriting sent success", async () => {
    const lookup = {channel: "telegram", connectorKey: "action-fence"};
    const action = await enqueueAction(lookup.connectorKey);
    const claimed = await actions.claimNextPendingAction(lookup);
    expect(claimed?.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    await expect(actions.markActionFailed(action.id, randomUUID(), "stale failure")).rejects.toThrow("no longer owns");
    await actions.markActionSent(action.id, claimed!.claimToken!);
    await actions.markActionSent(action.id, claimed!.claimToken!);
    await expect(actions.markActionFailed(action.id, claimed!.claimToken!, "late failure")).rejects.toThrow("no longer owns");
    await actions.markActionUnknown(action.id, claimed!.claimToken!, "late ambiguity");
    expect(await actions.expireActionIfDue(action.id, claimed!.claimToken!)).toBeNull();
    expect(await actions.getAction(action.id)).toMatchObject({status: "sent", lastError: undefined, attemptCount: 1});
  });

  liveIt("accepts the original owner's known result after startup declared an unknown outcome", async () => {
    const lookup = {channel: "telegram", connectorKey: "late-owner"};
    const delivery = await enqueueDelivery(lookup.connectorKey);
    const action = await enqueueAction(lookup.connectorKey);
    const claimedDelivery = await deliveries.claimNextPendingDelivery(lookup);
    const claimedAction = await actions.claimNextPendingAction(lookup);
    await deliveries.markSendingDeliveriesUnknown(lookup, "owner interrupted");
    await actions.markSendingActionsUnknown(lookup, "owner interrupted");
    expect(await deliveries.claimNextPendingDelivery(lookup)).toBeNull();
    expect(await actions.claimNextPendingAction(lookup)).toBeNull();
    await deliveries.markDeliverySent({id: delivery.id, claimToken: claimedDelivery!.claimToken!, sent: []});
    await actions.markActionSent(action.id, claimedAction!.claimToken!);
    expect((await deliveries.getDelivery(delivery.id)).status).toBe("sent");
    expect((await actions.getAction(action.id)).status).toBe("sent");
  });

  liveIt("reads committed success after lost acknowledgements without replaying external dispatch", async () => {
    const lookup = {channel: "telegram", connectorKey: "lost-ack"};
    const delivery = await enqueueDelivery(lookup.connectorKey);
    const action = await enqueueAction(lookup.connectorKey);
    const deliveryWrite = deliveries.markDeliverySent.bind(deliveries);
    const actionWrite = actions.markActionSent.bind(actions);
    const deliverySpy = vi.spyOn(deliveries, "markDeliverySent").mockImplementationOnce(async (input) => {
      await deliveryWrite(input);
      throw new Error("commit response lost");
    });
    const actionSpy = vi.spyOn(actions, "markActionSent").mockImplementationOnce(async (id, claimToken) => {
      await actionWrite(id, claimToken);
      throw new Error("commit response lost");
    });
    const send = vi.fn(async () => ({ok: true as const, channel: "telegram", target: delivery.target, sent: []}));
    const cleanup = vi.fn();
    const dispatch = vi.fn(async () => {});
    const onError = vi.fn();
    const deliveryWorker = new ChannelOutboundDeliveryWorker({store: deliveries, adapter: {channel: "telegram", send, onTerminalFailure: cleanup}, connectorKey: lookup.connectorKey, onError});
    const actionWorker = new ChannelActionWorker({store: actions, lookup, dispatch, onError});
    try {
      await deliveryWorker.start({subscribeToNotifications: false});
      await actionWorker.start({subscribeToNotifications: false});
      await Promise.all([deliveryWorker.triggerDrain(), actionWorker.triggerDrain()]);
    } finally {
      await Promise.all([deliveryWorker.stop(), actionWorker.stop()]);
      deliverySpy.mockRestore();
      actionSpy.mockRestore();
    }
    expect((await deliveries.getDelivery(delivery.id)).status).toBe("sent");
    expect((await actions.getAction(action.id)).status).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
