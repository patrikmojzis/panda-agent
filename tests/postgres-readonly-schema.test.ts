import { describe, expect, it } from "vitest";

import { ensureReadonlyChatQuerySchema } from "../src/index.js";

class RecordingQueryable {
  readonly queries: string[] = [];

  async query(text: string): Promise<{ rows: never[] }> {
    this.queries.push(text);
    return { rows: [] };
  }
}

describe("ensureReadonlyChatQuerySchema", () => {
  it("creates split chat views and grants access to them", async () => {
    const queryable = new RecordingQueryable();

    const views = await ensureReadonlyChatQuerySchema({
      queryable,
      readonlyRole: "readonly_user",
    });

    expect(views).toEqual({
      threads: "\"panda_threads\"",
      messages: "\"panda_messages\"",
      messagesRaw: "\"panda_messages_raw\"",
      toolResults: "\"panda_tool_results\"",
      inputs: "\"panda_inputs\"",
      runs: "\"panda_runs\"",
    });

    expect(queryable.queries).toHaveLength(2);
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_messages_raw\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_messages\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_tool_results\"");
    expect(queryable.queries[0]).toContain("FROM \"panda_messages_raw\" AS raw");
    expect(queryable.queries[0]).toContain("WHERE raw.role IN ('user', 'assistant')");
    expect(queryable.queries[1]).toContain("GRANT SELECT ON \"panda_threads\", \"panda_messages\", \"panda_messages_raw\", \"panda_tool_results\", \"panda_inputs\", \"panda_runs\"");
  });
});
