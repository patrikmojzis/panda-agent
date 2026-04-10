import {describe, expect, it} from "vitest";

import {resolveImplicitHomeThreadReplacementAgent} from "../src/features/panda/daemon.js";

describe("resolveImplicitHomeThreadReplacementAgent", () => {
  it("replaces a stale home thread when chat did not explicitly choose an agent", () => {
    expect(resolveImplicitHomeThreadReplacementAgent({
      requestedAgentKey: undefined,
      existingAgentKey: "panda",
      identityDefaultAgentKey: "jozef",
    })).toBe("jozef");
  });

  it("keeps the current home thread when it already matches the identity default", () => {
    expect(resolveImplicitHomeThreadReplacementAgent({
      requestedAgentKey: undefined,
      existingAgentKey: "jozef",
      identityDefaultAgentKey: "jozef",
    })).toBeUndefined();
  });

  it("does not replace the home thread when the user explicitly requested an agent", () => {
    expect(resolveImplicitHomeThreadReplacementAgent({
      requestedAgentKey: "panda",
      existingAgentKey: "jozef",
      identityDefaultAgentKey: "jozef",
    })).toBeUndefined();
  });

  it("does not replace the home thread when the identity has no default agent", () => {
    expect(resolveImplicitHomeThreadReplacementAgent({
      requestedAgentKey: undefined,
      existingAgentKey: "panda",
      identityDefaultAgentKey: undefined,
    })).toBeUndefined();
  });
});
