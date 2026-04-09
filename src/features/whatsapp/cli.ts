import process from "node:process";
import path from "node:path";

import { Command, InvalidArgumentError } from "commander";

import type { ProviderName } from "../agent-core/types.js";
import { resolveDefaultPandaModel, resolveDefaultPandaProvider } from "../panda/provider-defaults.js";
import { resolveWhatsAppConnectorKey, resolveWhatsAppDataDir } from "./config.js";
import { WhatsAppService } from "./service.js";

interface WhatsAppCliOptions {
  connector?: string;
  dbUrl?: string;
}

interface WhatsAppRunCliOptions extends WhatsAppCliOptions {
  provider?: ProviderName;
  model?: string;
  cwd?: string;
  readOnlyDbUrl?: string;
}

interface WhatsAppPairCliOptions extends WhatsAppCliOptions {
  phone: string;
}

function parseWhatsAppConnectorKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidArgumentError("WhatsApp connector key must not be empty.");
  }

  return trimmed;
}

function parseWhatsAppPhoneNumber(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new InvalidArgumentError("WhatsApp phone number must contain 8-15 digits.");
  }

  return digits;
}

function createWhatsAppService(options: WhatsAppRunCliOptions = {}): WhatsAppService {
  const provider = options.provider ?? resolveDefaultPandaProvider();
  const model = options.model ?? resolveDefaultPandaModel(provider);

  return new WhatsAppService({
    connectorKey: options.connector ?? resolveWhatsAppConnectorKey(),
    dataDir: resolveWhatsAppDataDir(),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    provider,
    model,
  });
}

export async function whatsappWhoamiCommand(options: WhatsAppCliOptions = {}): Promise<void> {
  const service = createWhatsAppService(options);

  try {
    const whoami = await service.whoami();
    process.stdout.write(
      [
        `WhatsApp connector ${whoami.connectorKey}`,
        `registered ${whoami.registered ? "yes" : "no"}`,
        `account ${whoami.accountId ?? "unpaired"}`,
        `name ${whoami.name ?? "-"}`,
      ].join("\n") + "\n",
    );
  } finally {
    await service.stop();
  }
}

export async function whatsappPairCommand(options: WhatsAppPairCliOptions): Promise<void> {
  const service = createWhatsAppService(options);

  try {
    const result = await service.pair(options.phone, (pairingCode) => {
      process.stdout.write(
        [
          `WhatsApp connector ${options.connector ?? resolveWhatsAppConnectorKey()}`,
          `phone ${options.phone}`,
          `pairing code ${pairingCode}`,
          "Enter the pairing code in WhatsApp and wait for the link to finish.",
        ].join("\n") + "\n",
      );
    });

    if (result.alreadyPaired) {
      process.stdout.write(
        [
          `WhatsApp connector ${result.connectorKey} is already paired.`,
          `account ${result.accountId ?? "unknown"}`,
          `name ${result.name ?? "-"}`,
        ].join("\n") + "\n",
      );
      return;
    }

    process.stdout.write(
      [
        `Paired WhatsApp connector ${result.connectorKey}.`,
        `account ${result.accountId ?? "unknown"}`,
        `name ${result.name ?? "-"}`,
      ].join("\n") + "\n",
    );
  } finally {
    await service.stop();
  }
}

export async function whatsappRunCommand(options: WhatsAppRunCliOptions): Promise<void> {
  const service = createWhatsAppService(options);

  const shutdown = async () => {
    await service.stop();
  };

  const handleSigint = () => {
    void shutdown();
  };
  const handleSigterm = () => {
    void shutdown();
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    await service.run();
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}

export function registerWhatsAppCommands(program: Command, parseCliProvider: (value: string) => ProviderName): void {
  const whatsappProgram = program
    .command("whatsapp")
    .description("Run and manage the WhatsApp channel");

  whatsappProgram
    .command("whoami")
    .description("Show the WhatsApp connector state and linked account")
    .option("--connector <key>", "Connector key override", parseWhatsAppConnectorKey)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((options: WhatsAppCliOptions) => {
      return whatsappWhoamiCommand(options);
    });

  whatsappProgram
    .command("pair")
    .description("Pair the WhatsApp connector using a phone-number pairing code")
    .requiredOption("--phone <number>", "Phone number to pair (digits only or E.164)", parseWhatsAppPhoneNumber)
    .option("--connector <key>", "Connector key override", parseWhatsAppConnectorKey)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((options: WhatsAppPairCliOptions) => {
      return whatsappPairCommand(options);
    });

  whatsappProgram
    .command("run")
    .description("Run the WhatsApp ingress worker")
    .option("--connector <key>", "Connector key override", parseWhatsAppConnectorKey)
    .option(
      "-p, --provider <provider>",
      "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
      parseCliProvider,
    )
    .option("-m, --model <model>", "Model name override")
    .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
    .action((options: WhatsAppRunCliOptions) => {
      return whatsappRunCommand(options);
    });
}
