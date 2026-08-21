import {randomUUID} from "node:crypto";

import {afterEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";
import {initAuthCreds, proto} from "baileys";

import {PostgresConnectorAccountStore} from "../src/domain/connectors/postgres.js";
import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {PostgresWhatsAppAuthStore} from "../src/integrations/channels/whatsapp/auth-store.js";

describe("PostgresWhatsAppAuthStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  async function createHarness(masterKey = "whatsapp-test-master-key") {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const crypto = new CredentialCrypto(masterKey);
    const auth = new PostgresWhatsAppAuthStore({pool, crypto});
    await auth.ensureSchema();
    const agents = new PostgresAgentStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    const accounts = new PostgresConnectorAccountStore({pool});
    const id = randomUUID();
    const account = await accounts.upsertAccount({
      id,
      source: "whatsapp",
      accountKey: "main",
      connectorKey: id,
      ownerKind: "agent",
      ownerAgentKey: "panda",
      status: "disabled",
    });
    return {account, auth, pool};
  }

  it("loads default creds and persists encrypted updates by account id", async () => {
    const {account, auth, pool} = await createHarness();
    await expect(auth.loadCreds(account.id)).resolves.toMatchObject({registered: false});

    const creds = initAuthCreds();
    creds.registered = true;
    creds.pairingCode = "123-456";
    await auth.saveCreds(account.id, creds);

    await expect(auth.loadCreds(account.id)).resolves.toMatchObject({registered: true, pairingCode: "123-456"});
    const raw = await pool.query("SELECT value_ciphertext::text AS ciphertext FROM runtime.whatsapp_account_auth_creds WHERE account_id = $1", [account.id]);
    expect(JSON.stringify(raw.rows)).not.toContain("123-456");
  });

  it("cannot decrypt auth with a different master key", async () => {
    const {account, auth, pool} = await createHarness();
    const creds = initAuthCreds();
    creds.registered = true;
    await auth.saveCreds(account.id, creds);

    const wrongKeyStore = new PostgresWhatsAppAuthStore({pool, crypto: new CredentialCrypto("different-key")});
    await expect(wrongKeyStore.loadCreds(account.id)).rejects.toThrow();
  });

  it("round-trips encrypted signal keys and deletes nulled entries", async () => {
    const {account, auth, pool} = await createHarness();
    const syncKey = proto.Message.AppStateSyncKeyData.fromObject({keyData: Buffer.from("abc")});
    await auth.saveSignalKeys(account.id, {
      session: {"session-1": Buffer.from("hello")},
      "app-state-sync-key": {"sync-1": syncKey},
    });

    const sessions = await auth.loadSignalKeys(account.id, "session", ["session-1"]);
    expect(Buffer.from(sessions["session-1"] ?? []).toString()).toBe("hello");
    const sync = await auth.loadSignalKeys(account.id, "app-state-sync-key", ["sync-1"]);
    expect(Buffer.from(sync["sync-1"]?.keyData ?? []).toString()).toBe("abc");
    const raw = await pool.query("SELECT value_ciphertext::text AS ciphertext FROM runtime.whatsapp_account_auth_keys WHERE account_id = $1", [account.id]);
    expect(JSON.stringify(raw.rows)).not.toContain("hello");

    await auth.saveSignalKeys(account.id, {session: {"session-1": null}});
    await expect(auth.loadSignalKeys(account.id, "session", ["session-1"])).resolves.toEqual({"session-1": undefined});
  });

  it("backs a Baileys auth state handle with the account", async () => {
    const {account, auth, pool} = await createHarness();
    await new PostgresConnectorAccountStore({pool}).enableAccount("whatsapp", account.accountKey);
    const handle = await auth.createAuthState(account.id);
    handle.state.creds.registered = true;
    await handle.state.keys.set({session: {"session-2": Buffer.from("pong")}});
    await handle.saveCreds();
    await expect(auth.loadCreds(account.id)).resolves.toMatchObject({registered: true});
    const sessions = await auth.loadSignalKeys(account.id, "session", ["session-2"]);
    expect(Buffer.from(sessions["session-2"] ?? []).toString()).toBe("pong");
  });

  it("does not recreate auth from a worker handle after the account is disabled and reset", async () => {
    const {account, auth, pool} = await createHarness();
    const accounts = new PostgresConnectorAccountStore({pool});
    await accounts.enableAccount("whatsapp", account.accountKey);
    const handle = await auth.createAuthState(account.id);
    handle.state.creds.registered = true;
    await handle.saveCreds();

    await accounts.disableAccount("whatsapp", account.accountKey);
    await auth.deleteAuthState(account.id);
    await handle.state.keys.set({session: {"late-session": Buffer.from("must-not-return")}});
    await handle.saveCreds();

    await expect(auth.hasAuthState(account.id)).resolves.toBe(false);
    await expect(auth.loadSignalKeys(account.id, "session", ["late-session"]))
      .resolves.toEqual({"late-session": undefined});
  });

  it("keeps transient pairing auth out of Postgres until promotion", async () => {
    const {account, auth, pool} = await createHarness();
    const handle = auth.createTransientAuthState();
    handle.state.creds.registered = true;
    handle.state.creds.me = {id: "246664333885442@lid", name: "Panda WhatsApp"};
    await handle.state.keys.set({session: {"session-3": Buffer.from("transient")}});
    await expect(auth.hasAuthState(account.id)).resolves.toBe(false);

    await handle.promoteTo(account.id);

    await expect(auth.hasAuthState(account.id)).resolves.toBe(true);
    const sessions = await auth.loadSignalKeys(account.id, "session", ["session-3"]);
    expect(Buffer.from(sessions["session-3"] ?? []).toString()).toBe("transient");
    await expect(new PostgresConnectorAccountStore({pool}).getAccountByKey("whatsapp", "main"))
      .resolves.toMatchObject({
        id: account.id,
        externalAccountId: "246664333885442@lid",
        displayName: "Panda WhatsApp",
        status: "enabled",
      });
  });

  it("rolls auth back instead of promoting it to a non-agent account", async () => {
    const {auth, pool} = await createHarness();
    const accounts = new PostgresConnectorAccountStore({pool});
    const id = randomUUID();
    await accounts.upsertAccount({
      id,
      source: "whatsapp",
      accountKey: "invalid-system-account",
      connectorKey: id,
      status: "disabled",
    });
    const handle = auth.createTransientAuthState();
    handle.state.creds.registered = true;
    handle.state.creds.me = {id: "421900000000@s.whatsapp.net"};
    await handle.state.keys.set({session: {"session-invalid": Buffer.from("must-rollback")}});

    await expect(handle.promoteTo(id)).rejects.toThrow("agent-owned connector account");
    await expect(auth.hasAuthState(id)).resolves.toBe(false);
    const rows = await pool.query(
      "SELECT COUNT(*)::int AS count FROM runtime.whatsapp_account_auth_keys WHERE account_id = $1",
      [id],
    );
    expect(rows.rows).toEqual([{count: 0}]);
  });

  it("cascades encrypted auth when the connector account is deleted", async () => {
    const {account, auth, pool} = await createHarness();
    await auth.saveCreds(account.id, initAuthCreds());
    await pool.query("DELETE FROM runtime.connector_accounts WHERE id = $1", [account.id]);
    await expect(auth.hasAuthState(account.id)).resolves.toBe(false);
  });
});
