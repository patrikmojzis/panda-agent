import {describe, expect, it, vi} from "vitest";

import {OpenAIImageClient, resolveOpenAIImageAuth,} from "../src/integrations/providers/openai-image/client.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

describe("OpenAI image client", () => {
  it("prefers Codex OAuth and gates OPENAI_API_KEY fallback", () => {
    expect(resolveOpenAIImageAuth({
      OPENAI_OAUTH_TOKEN: "codex-token",
    } as NodeJS.ProcessEnv)).toMatchObject({
      kind: "codex-oauth",
      token: "codex-token",
    });

    expect(() => resolveOpenAIImageAuth({
      OPENAI_API_KEY: "sk-test",
      CODEX_HOME: "/tmp/panda-missing-codex-home",
    } as NodeJS.ProcessEnv)).toThrow(/PANDA_IMAGE_ALLOW_OPENAI_API_KEY/);

    expect(resolveOpenAIImageAuth({
      OPENAI_API_KEY: "sk-test",
      PANDA_IMAGE_ALLOW_OPENAI_API_KEY: "true",
      CODEX_HOME: "/tmp/panda-missing-codex-home",
    } as NodeJS.ProcessEnv)).toMatchObject({
      kind: "openai-api-key",
      token: "sk-test",
    });
  });

  it("sends full image controls through the Codex image-generation tool", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      [
        "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"result\":\""
        + ONE_PIXEL_PNG_BASE64
        + "\"}}",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: {"Content-Type": "text/event-stream"},
      },
    ));
    const client = new OpenAIImageClient({
      env: {
        ...process.env,
        OPENAI_OAUTH_TOKEN: "codex-token",
        PANDA_IMAGE_CODEX_RESPONSES_MODEL: "gpt-test",
      },
      fetchImpl,
    });

    const result = await client.generate({
      prompt: "make an icon",
      model: "gpt-image-2",
      size: "auto",
      quality: "high",
      outputFormat: "webp",
      outputCompression: 80,
      background: "transparent",
      moderation: "low",
      count: 1,
    });

    const request = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe("gpt-test");
    expect(body.tools[0]).toMatchObject({
      type: "image_generation",
      model: "gpt-image-2",
      size: "auto",
      quality: "high",
      output_format: "webp",
      output_compression: 80,
      background: "transparent",
      moderation: "low",
    });
    expect(result).toMatchObject({
      authKind: "codex-oauth",
      model: "gpt-image-2",
      images: [{
        mimeType: "image/webp",
      }],
    });
  });
});
