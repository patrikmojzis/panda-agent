import {zstdDecompressSync} from "node:zlib";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ThinkingLevel} from "@earendil-works/pi-ai";

import {PiAiRuntime, closePiAiRuntimeResources} from "../src/integrations/providers/shared/runtime.js";

// Exercise the real pi-ai serializers and response parser over a mocked HTTP boundary.
// Force SSE so Codex cannot open a real WebSocket during these tests.
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  const streamSimple: typeof actual.streamSimple = (model, context, options) => (
    actual.streamSimple(model, context, {...options, transport: "sse"})
  );
  return {
    ...actual,
    streamSimple,
    completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
  } satisfies typeof actual;
});

describe("Astra provider requests", () => {
  afterEach(() => {
    closePiAiRuntimeResources();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const providerName of ["openai", "openai-codex"] as const) {
    for (const mode of ["complete", "stream"] as const) {
      it.each([undefined, "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
        `${providerName} ${mode} sends supported reasoning for %s and parses tool calls`,
        async (thinking: ThinkingLevel | undefined) => {
          vi.stubEnv("OPENAI_API_KEY", "test-api-key");
          const claims = Buffer.from(JSON.stringify({
            "https://api.openai.com/auth": {chatgpt_account_id: "test-account"},
          })).toString("base64url");
          vi.stubEnv("OPENAI_OAUTH_TOKEN", `test.${claims}.test`);

          const payloads: unknown[] = [];
          vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
            const request = new Request(input, init);
            const bytes = Buffer.from(await request.arrayBuffer());
            const body = request.headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(bytes).toString()
              : bytes.toString();
            payloads.push(JSON.parse(body));
            const item = {
              type: "function_call", id: "fc_test", call_id: "call_test",
              name: "lookup", arguments: '{"query":"hello"}', status: "completed",
            };
            const events = [
              {type: "response.output_item.done", output_index: 0, item},
              {type: "response.completed", response: {
                id: "resp_test", status: "completed", output: [item],
                usage: {input_tokens: 100, output_tokens: 10},
              }},
            ];
            return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
              headers: {"content-type": "text/event-stream"},
            });
          }));

          const runtime = new PiAiRuntime();
          const request = {
            providerName, modelId: "gpt-6-astra", thinking, temperature: 0.7,
            context: {
              messages: [],
              tools: [{name: "lookup", description: "Look up a query", parameters: {
                type: "object", properties: {query: {type: "string"}}, required: ["query"],
              }}],
            },
          };
          const response = mode === "complete"
            ? await runtime.complete(request)
            : await runtime.stream(request).result();

          expect(payloads).toEqual([expect.objectContaining({
            model: "gpt-6-astra",
            reasoning: expect.objectContaining({effort: !thinking || thinking === "minimal" ? "low" : thinking}),
            tools: [expect.objectContaining({type: "function", name: "lookup"})],
          })]);
          expect(payloads[0]).not.toHaveProperty("temperature");
          expect(response).toMatchObject({
            model: "gpt-6-astra", provider: providerName, stopReason: "toolUse",
            content: [expect.objectContaining({type: "toolCall", name: "lookup", arguments: {query: "hello"}})],
            usage: {cost: {input: 0.001, output: 0.0005, total: 0.0015}},
          });
        },
      );
    }
  }
});
