import {describe, expect, it} from "vitest";

import {renderPairedIdentitiesContext} from "../src/prompts/contexts/paired-identities.js";

describe("renderPairedIdentitiesContext", () => {
  it("adds renderer truncation to bindings already omitted by the directory", () => {
    const content = renderPairedIdentitiesContext([{
      handle: "alice",
      displayName: "Alice",
      channelHints: Array.from({length: 6}, (_, index) => ({
        source: "telegram",
        connectorKey: "bot-main",
        externalActorId: `actor-${index}`,
      })),
      additionalChannelHintCount: 2,
    }]);

    expect(content).toContain("4 more channel hint(s)");
    expect(content).not.toContain("actor-4");
  });
});
