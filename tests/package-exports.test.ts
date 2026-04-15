import {readFileSync} from "node:fs";

import {describe, expect, it} from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  exports: Record<string, { types: string; import: string }>;
};

const EXPECTED_EXPORTS = {
  ".": {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  },
  "./app/runtime": {
    types: "./dist/app/runtime/index.d.ts",
    import: "./dist/app/runtime/index.js",
  },
  "./kernel/agent": {
    types: "./dist/kernel/agent/index.d.ts",
    import: "./dist/kernel/agent/index.js",
  },
  "./personas/panda": {
    types: "./dist/personas/panda/index.d.ts",
    import: "./dist/personas/panda/index.js",
  },
  "./domain/agents": {
    types: "./dist/domain/agents/index.d.ts",
    import: "./dist/domain/agents/index.js",
  },
  "./domain/identity": {
    types: "./dist/domain/identity/index.d.ts",
    import: "./dist/domain/identity/index.js",
  },
  "./domain/channels": {
    types: "./dist/domain/channels/index.d.ts",
    import: "./dist/domain/channels/index.js",
  },
  "./domain/channels/actions": {
    types: "./dist/domain/channels/actions/index.d.ts",
    import: "./dist/domain/channels/actions/index.js",
  },
  "./domain/channels/deliveries": {
    types: "./dist/domain/channels/deliveries/index.d.ts",
    import: "./dist/domain/channels/deliveries/index.js",
  },
  "./domain/threads": {
    types: "./dist/domain/threads/index.d.ts",
    import: "./dist/domain/threads/index.js",
  },
  "./domain/threads/requests": {
    types: "./dist/domain/threads/requests/index.d.ts",
    import: "./dist/domain/threads/requests/index.js",
  },
  "./domain/threads/runtime": {
    types: "./dist/domain/threads/runtime/index.d.ts",
    import: "./dist/domain/threads/runtime/index.js",
  },
  "./domain/scheduling": {
    types: "./dist/domain/scheduling/index.d.ts",
    import: "./dist/domain/scheduling/index.js",
  },
  "./domain/scheduling/tasks": {
    types: "./dist/domain/scheduling/tasks/index.d.ts",
    import: "./dist/domain/scheduling/tasks/index.js",
  },
  "./domain/watches": {
    types: "./dist/domain/watches/index.d.ts",
    import: "./dist/domain/watches/index.js",
  },
  "./integrations/shell": {
    types: "./dist/integrations/shell/index.d.ts",
    import: "./dist/integrations/shell/index.js",
  },
} as const;

describe("package exports", () => {
  it("matches the intentional root and subpath entrypoints", () => {
    expect(packageJson.exports).toEqual(EXPECTED_EXPORTS);
  });

  it("does not expose internal implementation subpaths", () => {
    expect(packageJson.exports).not.toHaveProperty("./domain/credentials");
    expect(packageJson.exports).not.toHaveProperty("./domain/sessions/conversations");
    expect(packageJson.exports).not.toHaveProperty("./domain/threads/conversations");
    expect(packageJson.exports).not.toHaveProperty("./domain/threads/routes");
    expect(packageJson.exports).not.toHaveProperty("./integrations/channels/telegram");
    expect(packageJson.exports).not.toHaveProperty("./integrations/channels/whatsapp");
    expect(packageJson.exports).not.toHaveProperty("./personas/panda/tools/bash-tool");
    expect(packageJson.exports).not.toHaveProperty("./personas/panda/tools/env-value-tools");
    expect(packageJson.exports).not.toHaveProperty("./personas/panda/tools/web-fetch");
    expect(packageJson.exports).not.toHaveProperty("./personas/panda/tools/web-fetch-tool");
  });
});
