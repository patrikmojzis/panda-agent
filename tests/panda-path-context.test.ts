import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {resolveContextPath} from "../src/app/runtime/panda-path-context.js";

describe("resolveContextPath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("maps remote runner agent-home paths back to the local agent home", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveContextPath("/root/.panda/agents/jozef/media/browser/shot.png", {
      agentKey: "jozef",
    })).toBe(path.join("/Users/tester/.panda", "agents", "jozef", "media", "browser", "shot.png"));
  });

  it("maps relative paths resolved from the remote runner cwd", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveContextPath("media/telegram/photo.jpg", {
      agentKey: "jozef",
      shell: {
        cwd: "/root/.panda/agents/jozef",
        env: {},
      },
    })).toBe(path.join("/Users/tester/.panda", "agents", "jozef", "media", "telegram", "photo.jpg"));
  });

  it("leaves non-agent-home paths alone in remote mode", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveContextPath("/workspace/shared/report.png", {
      agentKey: "jozef",
    })).toBe("/workspace/shared/report.png");
  });
});
