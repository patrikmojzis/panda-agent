import type {Command} from "commander";
import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {normalizeIdentityHandle} from "../identity/types.js";
import type {IdentityRecord} from "../identity/types.js";
import {PostgresControlAuthService} from "./auth.js";
import type {ControlGrantRole} from "./types.js";

interface GrantOptions {
  dbUrl?: string;
  identity: string;
  role: ControlGrantRole;
  agent?: string;
  label?: string;
}

async function maybeGetIdentityById(store: PostgresIdentityStore, identityId: string): Promise<IdentityRecord | null> {
  try {
    return await store.getIdentity(identityId);
  } catch (error) {
    if (error instanceof Error && error.message === `Unknown identity ${identityId}`) {
      return null;
    }

    throw error;
  }
}

async function maybeGetIdentityByHandle(store: PostgresIdentityStore, value: string): Promise<IdentityRecord | null> {
  let handle: string;
  try {
    handle = normalizeIdentityHandle(value);
  } catch {
    return null;
  }

  try {
    return await store.getIdentityByHandle(handle);
  } catch (error) {
    if (error instanceof Error && error.message === `Unknown identity handle ${handle}`) {
      return null;
    }

    throw error;
  }
}

async function resolveControlGrantIdentityId(store: PostgresIdentityStore, value: string): Promise<string> {
  const identityValue = value.trim();
  if (!identityValue) {
    throw new Error("Control grant --identity must be an identity id or handle. Run `panda identity list` to see available identities.");
  }

  const [byId, byHandle] = await Promise.all([
    maybeGetIdentityById(store, identityValue),
    maybeGetIdentityByHandle(store, identityValue),
  ]);

  if (byId && byHandle && byId.id !== byHandle.id) {
    throw new Error(`Ambiguous Control grant identity ${identityValue}: it matches identity id ${byId.id} and handle ${byHandle.handle} (${byHandle.id}). Use the identity id to disambiguate.`);
  }

  const identity = byId ?? byHandle;
  if (!identity) {
    throw new Error(`Unknown Control grant identity ${identityValue}. Run \`panda identity list\` and pass an identity id or handle.`);
  }

  return identity.id;
}

export function registerControlCommands(program: Command): void {
  const control = program.command("control").description("Manage Panda Control access");
  control.command("grant")
    .description("Create a Control login grant and print its one-time operator login token")
    .requiredOption("--identity <identity>", "Identity id or handle receiving Control access")
    .requiredOption("--role <admin|scoped>", "Control role")
    .option("--agent <agentKey>", "Required for scoped Control grants")
    .option("--label <label>", "Human-readable grant label")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (options: GrantOptions) => {
      await withPostgresPool(options.dbUrl, async (pool) => {
        const auth = new PostgresControlAuthService({pool});
        const identities = new PostgresIdentityStore({pool});
        await identities.ensureSchema();
        await auth.ensureSchema();
        const identityId = await resolveControlGrantIdentityId(identities, options.identity);
        const created = await auth.createGrant({
          identityId,
          role: options.role,
          agentKey: options.agent,
          label: options.label,
        });
        process.stdout.write(`${JSON.stringify({
          grant: created.grant,
          loginToken: created.loginToken,
        }, null, 2)}\n`);
      });
    });
}
