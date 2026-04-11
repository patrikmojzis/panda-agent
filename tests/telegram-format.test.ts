import {describe, expect, it} from "vitest";

import {markdownToTelegramHtml} from "../src/integrations/channels/telegram/format.js";

describe("markdownToTelegramHtml", () => {
  it("renders the common markdown Panda sends into Telegram-safe HTML", () => {
    expect(markdownToTelegramHtml("**Nastroje**\n\n- Bash\n- Web fetch")).toBe(
      "<b>Nastroje</b>\n\n• Bash\n• Web fetch",
    );
  });

  it("renders links, headings, and code blocks", () => {
    expect(markdownToTelegramHtml("# Docs\n\nSee [guide](https://example.com)\n\n```ts\nconst x = 1;\n```")).toBe(
      '<b>Docs</b>\n\nSee <a href="https://example.com">guide</a>\n\n<pre><code>const x = 1;</code></pre>',
    );
  });

  it("escapes raw html instead of trusting it", () => {
    expect(markdownToTelegramHtml("<b>nope</b>")).toBe("&lt;b&gt;nope&lt;/b&gt;");
  });
});
