import {describe, expect, it} from "vitest";

import {renderBackgroundToolJobEventPrompt} from "../src/prompts/runtime/background-tool-job.js";

describe("renderBackgroundToolJobEventPrompt", () => {
  it("renders image generation paths from structured metadata without relying on the text preview", () => {
    const firstPath = `/Users/patrikmojzis/.panda/agents/panda/media/image-generation/thread/${"a".repeat(180)}-1.png`;
    const secondPath = `/Users/patrikmojzis/.panda/agents/panda/media/image-generation/thread/${"b".repeat(180)}-2.png`;

    const prompt = renderBackgroundToolJobEventPrompt({
      jobId: "job-1",
      kind: "image_generate",
      status: "completed",
      summary: "Generate two images",
      result: {
        contentText: `Generated 2 images.\nImage 1: ${firstPath}\nImage 2: ${secondPath}`,
        details: {
          images: [
            {path: firstPath},
            {path: secondPath},
          ],
        },
      },
    });

    expect(prompt).toContain(`Image 1: ${firstPath}`);
    expect(prompt).toContain(`Image 2: ${secondPath}`);
    expect(prompt).not.toContain("Result:");
  });

  it("keeps a larger stdout preview for completed background jobs", () => {
    const stdout = "x".repeat(350);
    const prompt = renderBackgroundToolJobEventPrompt({
      jobId: "job-1",
      kind: "bash",
      status: "completed",
      summary: "wait for game",
      result: {
        stdout,
      },
    });

    expect(prompt).toContain(stdout);
  });
});
