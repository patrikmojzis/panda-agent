import {afterEach, describe, expect, it, vi} from "vitest";
import {
    whatsappLinkCommand,
    whatsappPairCommand,
    whatsappUnpairCommand,
    whatsappWhoamiCommand
} from "../src/integrations/channels/whatsapp/cli.js";

const whatsappCliMocks = vi.hoisted(() => {
  const serviceInstances: MockWhatsAppService[] = [];
  const identityStoreInstances: MockPostgresIdentityStore[] = [];
  let deleteIdentityBindingResult = true;

  class MockWhatsAppService {
    readonly whoami = vi.fn(async () => ({
      connectorKey: "main",
      registered: true,
      accountId: "421900000000:12@s.whatsapp.net",
      name: "Panda",
    }));
    readonly pair = vi.fn(async (_phone: string, onPairingCode?: (code: string) => void) => {
      onPairingCode?.("ABC-123");
      return {
        connectorKey: "main",
        registered: true,
        accountId: "421900000000:12@s.whatsapp.net",
        name: "Panda",
        alreadyPaired: false,
      };
    });
    readonly run = vi.fn(async () => {});
    readonly stop = vi.fn(async () => {});

    constructor(_options: unknown) {
      serviceInstances.push(this);
    }
  }

  class MockPostgresIdentityStore {
    readonly getIdentityByHandle = vi.fn(async (handle: string) => ({
      id: `identity-${handle}`,
      handle,
      displayName: handle,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    }));
    readonly ensureIdentityBinding = vi.fn(async (input: {
      source: string;
      connectorKey: string;
      externalActorId: string;
      identityId: string;
      metadata?: unknown;
    }) => ({
      id: "binding-1",
      ...input,
      createdAt: 0,
      updatedAt: 0,
    }));
    readonly deleteIdentityBinding = vi.fn(async (_lookup: {
      source: string;
      connectorKey: string;
      externalActorId: string;
    }) => deleteIdentityBindingResult);

    constructor(_options: unknown) {
      identityStoreInstances.push(this);
    }
  }

  return {
    MockPostgresIdentityStore,
    MockWhatsAppService,
    identityStoreInstances,
    serviceInstances,
    setDeleteIdentityBindingResult: (result: boolean) => {
      deleteIdentityBindingResult = result;
    },
  };
});

vi.mock("../src/app/runtime/postgres-bootstrap.js", () => ({
  ensureSchemas: vi.fn(async () => {}),
  withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: unknown) => Promise<unknown>) => {
    return fn({});
  }),
}));

vi.mock("../src/domain/identity/index.js", () => ({
  PostgresIdentityStore: whatsappCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/integrations/channels/whatsapp/service.js", () => ({
  WhatsAppService: whatsappCliMocks.MockWhatsAppService,
}));

function latestService(): InstanceType<typeof whatsappCliMocks.MockWhatsAppService> {
  const service = whatsappCliMocks.serviceInstances.at(-1);
  if (!service) {
    throw new Error("Expected a mocked WhatsApp service instance.");
  }

  return service;
}

function latestIdentityStore(): InstanceType<typeof whatsappCliMocks.MockPostgresIdentityStore> {
  const store = whatsappCliMocks.identityStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked identity store instance.");
  }

  return store;
}

describe("WhatsApp CLI", () => {
  afterEach(() => {
    whatsappCliMocks.identityStoreInstances.length = 0;
    whatsappCliMocks.serviceInstances.length = 0;
    whatsappCliMocks.setDeleteIdentityBindingResult(true);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads connector identity directly for whoami", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappWhoamiCommand({
      connector: "main",
      dbUrl: "postgres://wa-db",
    });

    expect(latestService().whoami).toHaveBeenCalledTimes(1);
    expect(latestService().stop).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      [
        "WhatsApp connector main",
        "registered yes",
        "account 421900000000:12@s.whatsapp.net",
        "name Panda",
      ].join("\n") + "\n",
    );
  });

  it("prints the linking code and success details", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappLinkCommand({
      phone: "421900000000",
      connector: "main",
      dbUrl: "postgres://wa-db",
    });

    expect(latestService().pair).toHaveBeenCalledTimes(1);
    expect(latestService().stop).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      [
        "WhatsApp connector main",
        "phone 421900000000",
        "pairing code ABC-123",
        "Enter the pairing code in WhatsApp and wait for the link to finish.",
      ].join("\n") + "\n",
    );
    expect(write).toHaveBeenCalledWith(
      [
        "Linked WhatsApp connector main.",
        "account 421900000000:12@s.whatsapp.net",
        "name Panda",
      ].join("\n") + "\n",
    );
  });

  it("pairs a WhatsApp sender phone to an identity through the pair command", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappPairCommand({
      actor: "421911111111@s.whatsapp.net",
      identity: "alice",
      connector: "main",
      dbUrl: "postgres://wa-db",
    });

    expect(latestIdentityStore().getIdentityByHandle).toHaveBeenCalledWith("alice");
    expect(latestIdentityStore().ensureIdentityBinding).toHaveBeenCalledWith({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "421911111111@s.whatsapp.net",
      identityId: "identity-alice",
      metadata: {
        pairedVia: "whatsapp-cli",
      },
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Paired WhatsApp actor 421911111111@s.whatsapp.net.",
        "identity identity-alice",
        "connector main",
      ].join("\n") + "\n",
    );
  });

  it("pairs a WhatsApp LID actor to an identity through the pair command", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappPairCommand({
      actor: "246664333885442@lid",
      identity: "alice",
      connector: "main",
      dbUrl: "postgres://wa-db",
    });

    expect(latestIdentityStore().ensureIdentityBinding).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "246664333885442@lid",
      identityId: "identity-alice",
    }));
    expect(write).toHaveBeenCalledWith(
      [
        "Paired WhatsApp actor 246664333885442@lid.",
        "identity identity-alice",
        "connector main",
      ].join("\n") + "\n",
    );
  });

  it("unpairs a WhatsApp actor through the identity store", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappUnpairCommand({
      actor: "421911111111",
      connector: "main",
      dbUrl: "postgres://wa-db",
    });

    expect(latestIdentityStore().deleteIdentityBinding).toHaveBeenCalledWith({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "421911111111@s.whatsapp.net",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Unpaired WhatsApp actor 421911111111@s.whatsapp.net.",
        "connector main",
      ].join("\n") + "\n",
    );
  });

  it("reports when a WhatsApp actor had no pairing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    whatsappCliMocks.setDeleteIdentityBindingResult(false);

    await whatsappUnpairCommand({
      actor: "246664333885442@lid",
      connector: "main",
      dbUrl: "postgres://wa-db",
    });

    expect(write).toHaveBeenCalledWith(
      [
        "No WhatsApp pairing found for actor 246664333885442@lid.",
        "connector main",
      ].join("\n") + "\n",
    );
  });
});
