import type {CommandScope} from "../../src/domain/commands/types.js";
import type {CommandLeaseVerifier} from "../../src/integrations/commands/http-server.js";

export function createTestCommandLeaseVerifier(
  entries: Iterable<readonly [string, CommandScope]> = [],
): CommandLeaseVerifier {
  const leases = new Map(entries);
  return {
    async verify(token) {
      return leases.get(token);
    },
  };
}
