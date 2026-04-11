import {afterEach, describe, expect, it, vi} from "vitest";
import {whatsappPairCommand, whatsappWhoamiCommand} from "../src/integrations/channels/whatsapp/cli.js";

const whatsappCliMocks = vi.hoisted(() => {
  const serviceInstances: MockWhatsAppService[] = [];

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

  return {
    MockWhatsAppService,
    serviceInstances,
  };
});

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

describe("WhatsApp CLI", () => {
  afterEach(() => {
    whatsappCliMocks.serviceInstances.length = 0;
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

  it("prints the pairing code and success details", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappPairCommand({
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
        "Paired WhatsApp connector main.",
        "account 421900000000:12@s.whatsapp.net",
        "name Panda",
      ].join("\n") + "\n",
    );
  });
});
