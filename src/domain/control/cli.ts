import type {Command} from "commander";
import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {PostgresControlAuthService} from "./auth.js";
import type {ControlGrantRole} from "./types.js";

interface GrantOptions {
  dbUrl?: string;
  identity: string;
  role: ControlGrantRole;
  agent?: string;
  label?: string;
}

export function registerControlCommands(program: Command): void {
  const control = program.command("control").description("Manage Panda Control access");
  control.command("grant")
    .description("Create a Control login grant and print its one-time operator login token")
    .requiredOption("--identity <identityId>", "Identity id receiving Control access")
    .requiredOption("--role <admin|scoped>", "Control role")
    .option("--agent <agentKey>", "Required for scoped Control grants")
    .option("--label <label>", "Human-readable grant label")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action(async (options: GrantOptions) => {
      await withPostgresPool(options.dbUrl, async (pool) => {
        const auth = new PostgresControlAuthService({pool});
        await auth.ensureSchema();
        const created = await auth.createGrant({
          identityId: options.identity,
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
