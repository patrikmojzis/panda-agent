import {describe, expect, it} from "vitest";

import {renderTuiInboundText} from "../src/prompts/channels/tui.js";

describe("tui inbound text", () => {
  it("renders turn-local identity metadata in the message header", () => {
    const text = renderTuiInboundText({
      actorId: "local-user",
      externalMessageId: "msg-1",
      identityId: "patrik-id",
      identityHandle: "patrik",
      body: "hello from terminal",
    });

    expect(text).toContain("<runtime-input-context>");
    expect(text).toContain("source: tui");
    expect(text).toContain("actor_id: local-user");
    expect(text).toContain("identity_id: patrik-id");
    expect(text).toContain("identity_handle: patrik");
    expect(text).toContain("hello from terminal");
  });
});
