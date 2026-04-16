import process from "node:process";
import {createInterface} from "node:readline/promises";

import {Command} from "commander";

import {parseAgentKey} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {parseIdentityHandle} from "../identity/cli.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {PostgresCredentialStore} from "./postgres.js";
import {CredentialService} from "./resolver.js";
import {resolveCredentialCrypto} from "./crypto.js";
import type {CredentialListEntry, CredentialScopeInput} from "./types.js";
import {maskCredentialValue} from "./types.js";

interface CredentialCliOptions {
  dbUrl?: string;
  agent?: string;
  identity?: string;
  stdin?: boolean;
}

async function readSecretFromPrompt(prompt: string): Promise<string> {
  const readline = createInterface(process.stdin, process.stdout);
  const originalWrite = (readline as unknown as {_writeToOutput?: (value: string) => void})._writeToOutput;
  (readline as unknown as {_writeToOutput?: (value: string) => void})._writeToOutput = (value: string) => {
    if (value === prompt || value.includes("\n")) {
      process.stdout.write(value);
    }
  };

  try {
    const value = await readline.question(prompt);
    process.stdout.write("\n");
    return value;
  } finally {
    (readline as unknown as {_writeToOutput?: (value: string) => void})._writeToOutput = originalWrite;
    readline.close();
  }
}

async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function withCredentialStores<T>(
  options: CredentialCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    credentialStore: PostgresCredentialStore;
    identityStore: PostgresIdentityStore;
  }) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const agentStore = new PostgresAgentStore({pool});
    const identityStore = new PostgresIdentityStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});

    await ensureSchemas([identityStore, agentStore, credentialStore]);
    return await fn({agentStore, credentialStore, identityStore});
  });
}

async function withCredentialService<T>(
  options: CredentialCliOptions,
  fn: (stores: {
    agentStore: PostgresAgentStore;
    credentialService: CredentialService;
    identityStore: PostgresIdentityStore;
  }) => Promise<T>,
): Promise<T> {
  return withCredentialStores(options, async ({agentStore, credentialStore, identityStore}) => {
    const crypto = resolveCredentialCrypto();
    if (!crypto) {
      throw new Error("CREDENTIALS_MASTER_KEY is required for credential commands.");
    }

    const credentialService = new CredentialService({
      store: credentialStore,
      crypto,
    });

    return fn({agentStore, credentialService, identityStore});
  });
}

async function resolveScopeOptions(
  options: CredentialCliOptions,
  stores: {
    agentStore: PostgresAgentStore;
    identityStore: PostgresIdentityStore;
  },
  mode: "required" | "optional",
): Promise<CredentialScopeInput | null> {
  const agentKey = options.agent?.trim();
  const identityHandle = options.identity?.trim();

  if (!agentKey && !identityHandle) {
    if (mode === "optional") {
      return null;
    }

    throw new Error("Pick a credential scope with --agent, --identity, or both.");
  }

  const resolvedAgentKey = agentKey
    ? (await stores.agentStore.getAgent(agentKey)).agentKey
    : undefined;
  const resolvedIdentityId = identityHandle
    ? (await stores.identityStore.getIdentityByHandle(identityHandle)).id
    : undefined;

  if (resolvedAgentKey && resolvedIdentityId) {
    return {
      scope: "relationship",
      agentKey: resolvedAgentKey,
      identityId: resolvedIdentityId,
    };
  }

  if (resolvedAgentKey) {
    return {
      scope: "agent",
      agentKey: resolvedAgentKey,
    };
  }

  return {
    scope: "identity",
    identityId: resolvedIdentityId,
  };
}

async function resolveIdentityHandles(
  entries: readonly CredentialListEntry[],
  identityStore: PostgresIdentityStore,
): Promise<Map<string, string>> {
  const handles = new Map<string, string>();
  const ids = [...new Set(entries.flatMap((entry) => entry.identityId ? [entry.identityId] : []))];

  await Promise.all(ids.map(async (identityId) => {
    const identity = await identityStore.getIdentity(identityId);
    handles.set(identityId, identity.handle);
  }));

  return handles;
}

function renderCredentialEntry(entry: CredentialListEntry, identityHandles: Map<string, string>): string {
  return [
    entry.envKey,
    `  scope ${entry.scope}`,
    ...(entry.agentKey ? [`  agent ${entry.agentKey}`] : []),
    ...(entry.identityId ? [`  identity ${identityHandles.get(entry.identityId) ?? entry.identityId}`] : []),
    `  value ${entry.valuePreview}`,
    `  updated ${new Date(entry.updatedAt).toISOString()}`,
  ].join("\n");
}

async function readCredentialValue(value: string | undefined, stdin: boolean | undefined): Promise<string> {
  if (stdin) {
    if (value !== undefined) {
      throw new Error("Pick one input path: positional value or --stdin.");
    }

    const piped = await readSecretFromStdin();
    if (!piped) {
      throw new Error("stdin did not provide a credential value.");
    }

    return piped;
  }

  if (value !== undefined) {
    return value;
  }

  if (!process.stdin.isTTY) {
    throw new Error("Pass a value, use --stdin, or run interactively for a hidden prompt.");
  }

  const prompted = await readSecretFromPrompt("Credential value: ");
  if (!prompted) {
    throw new Error("Credential value must not be empty.");
  }

  return prompted;
}

export async function setCredentialCommand(
  envKey: string,
  value: string | undefined,
  options: CredentialCliOptions,
): Promise<void> {
  await withCredentialService(options, async ({agentStore, credentialService, identityStore}) => {
    const scope = await resolveScopeOptions(options, {agentStore, identityStore}, "required");
    if (!scope) {
      throw new Error("Missing credential scope.");
    }

    const stored = await credentialService.setCredential({
      envKey,
      value: await readCredentialValue(value, options.stdin),
      ...scope,
    });
    const identityHandle = stored.identityId
      ? (await identityStore.getIdentity(stored.identityId)).handle
      : null;

    process.stdout.write(
      [
        `Stored ${stored.envKey}.`,
        `scope ${stored.scope}`,
        ...(stored.agentKey ? [`agent ${stored.agentKey}`] : []),
        ...(identityHandle ? [`identity ${identityHandle}`] : []),
        `value ${maskCredentialValue(stored.value)}`,
      ].join("\n") + "\n",
    );
  });
}

export async function clearCredentialCommand(
  envKey: string,
  options: CredentialCliOptions,
): Promise<void> {
  await withCredentialStores(options, async ({agentStore, credentialStore, identityStore}) => {
    const scope = await resolveScopeOptions(options, {agentStore, identityStore}, "required");
    if (!scope) {
      throw new Error("Missing credential scope.");
    }

    const deleted = await credentialStore.deleteCredential(
      envKey,
      {
      ...scope,
      },
    );

    process.stdout.write(
      [
        deleted ? `Cleared ${envKey}.` : `No credential cleared for ${envKey}.`,
        `scope ${scope.scope}`,
        ...(scope.agentKey ? [`agent ${scope.agentKey}`] : []),
        ...(scope.identityId
          ? [`identity ${(await identityStore.getIdentity(scope.identityId)).handle}`]
          : []),
      ].join("\n") + "\n",
    );
  });
}

export async function listCredentialsCommand(options: CredentialCliOptions): Promise<void> {
  await withCredentialService(options, async ({agentStore, credentialService, identityStore}) => {
    const scope = await resolveScopeOptions(options, {agentStore, identityStore}, "optional");
    const entries = await credentialService.listCredentials(scope ? {
      scope: scope.scope,
      agentKey: scope.agentKey,
      identityId: scope.identityId,
    } : {});

    if (entries.length === 0) {
      process.stdout.write("No credentials yet.\n");
      return;
    }

    const identityHandles = await resolveIdentityHandles(entries, identityStore);
    process.stdout.write(entries.map((entry) => renderCredentialEntry(entry, identityHandles)).join("\n\n") + "\n");
  });
}

export async function resolveCredentialCommand(
  envKey: string,
  options: CredentialCliOptions,
): Promise<void> {
  await withCredentialService(options, async ({agentStore, credentialService, identityStore}) => {
    const scope = await resolveScopeOptions(options, {agentStore, identityStore}, "required");
    if (!scope) {
      throw new Error("Missing credential scope.");
    }

    const resolved = await credentialService.resolveCredential(envKey, {
      agentKey: scope.agentKey,
      identityId: scope.identityId,
    });

    if (!resolved) {
      process.stdout.write(
        [
          `No stored credential matched ${envKey}.`,
          "Note: local bash may still fall back to Panda process env.",
        ].join("\n") + "\n",
      );
      return;
    }

    process.stdout.write(
      [
        `Stored winner for ${resolved.envKey}.`,
        `scope ${resolved.scope}`,
        ...(resolved.agentKey ? [`agent ${resolved.agentKey}`] : []),
        ...(resolved.identityId ? [`identity ${(await identityStore.getIdentity(resolved.identityId)).handle}`] : []),
        `value ${resolved.valuePreview}`,
        "Note: this inspects stored credentials only.",
      ].join("\n") + "\n",
    );
  });
}

export function registerCredentialCommands(program: Command): void {
  const credentialProgram = program
    .command("credentials")
    .description("Manage stored env credentials for Panda bash");

  credentialProgram
    .command("set")
    .description("Store a credential for a relationship, agent, or identity")
    .argument("<envKey>", "Shell env key")
    .argument("[value]", "Credential value. Prefer --stdin or the hidden prompt.")
    .option("--agent <agentKey>", "Which persona should receive it", parseAgentKey)
    .option("--identity <handle>", "Who owns this credential", parseIdentityHandle)
    .option("--stdin", "Read the credential value from stdin")
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((envKey: string, value: string | undefined, options: CredentialCliOptions) => {
      return setCredentialCommand(envKey, value, options);
    });

  credentialProgram
    .command("clear")
    .description("Delete a credential from an exact scope")
    .argument("<envKey>", "Shell env key")
    .option("--agent <agentKey>", "Which persona should lose it", parseAgentKey)
    .option("--identity <handle>", "Which owner should lose it", parseIdentityHandle)
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((envKey: string, options: CredentialCliOptions) => {
      return clearCredentialCommand(envKey, options);
    });

  credentialProgram
    .command("list")
    .description("List stored credentials, optionally narrowed to one exact scope")
    .option("--agent <agentKey>", "Filter to one persona", parseAgentKey)
    .option("--identity <handle>", "Filter to one owner", parseIdentityHandle)
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((options: CredentialCliOptions) => {
      return listCredentialsCommand(options);
    });

  credentialProgram
    .command("resolve")
    .description("Show which stored credential wins in the credentials store")
    .argument("<envKey>", "Shell env key")
    .option("--agent <agentKey>", "Persona context", parseAgentKey)
    .option("--identity <handle>", "Owner context", parseIdentityHandle)
    .option("--db-url <url>", "Postgres connection string for credential persistence")
    .action((envKey: string, options: CredentialCliOptions) => {
      return resolveCredentialCommand(envKey, options);
    });
}
