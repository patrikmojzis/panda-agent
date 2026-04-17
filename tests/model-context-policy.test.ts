import {describe, expect, it} from "vitest";

import {
  DEFAULT_MODEL_CONTEXT_POLICY,
  getCompactTriggerTokens,
  type ModelContextPolicyRule,
  resolveEffectiveThreadContextBudget,
  resolveModelContextPolicy,
} from "../src/kernel/models/model-context-policy.js";

describe("model context policy", () => {
  it("prefers exact matches over family prefixes", () => {
    const rules: readonly ModelContextPolicyRule[] = [
      {
        kind: "prefix",
        match: "gpt-5",
        hardWindow: 1_000,
        operatingWindow: 800,
        compactAtPercent: 70,
      },
      {
        kind: "exact",
        match: "gpt-5.4",
        hardWindow: 2_000,
        operatingWindow: 1_500,
        compactAtPercent: 90,
      },
    ];

    const resolved = resolveModelContextPolicy("openai/gpt-5.4", {rules});

    expect(resolved.matchKind).toBe("exact");
    expect(resolved.match).toBe("gpt-5.4");
    expect(resolved.hardWindow).toBe(2_000);
    expect(resolved.operatingWindow).toBe(1_500);
    expect(resolved.compactAtPercent).toBe(90);
  });

  it("falls back to family prefixes by model id regardless of provider", () => {
    const resolved = resolveModelContextPolicy("anthropic-oauth/claude-opus-4-6");

    expect(resolved.matchKind).toBe("prefix");
    expect(resolved.match).toBe("claude-opus-4");
    expect(resolved.modelId).toBe("claude-opus-4-6");
    expect(resolved.operatingWindow).toBe(200_000);
    expect(resolved.compactAtPercent).toBe(85);
  });

  it("uses the global fallback when no model policy matches", () => {
    const resolved = resolveModelContextPolicy("weird-provider/something-new");

    expect(resolved.matchKind).toBe("fallback");
    expect(resolved.hardWindow).toBe(DEFAULT_MODEL_CONTEXT_POLICY.hardWindow);
    expect(resolved.operatingWindow).toBe(DEFAULT_MODEL_CONTEXT_POLICY.operatingWindow);
    expect(resolved.compactAtPercent).toBe(DEFAULT_MODEL_CONTEXT_POLICY.compactAtPercent);
  });

  it("applies the thread override to the active operating window and trigger", () => {
    const resolved = resolveEffectiveThreadContextBudget({
      model: "openai/gpt-5.4",
      maxInputTokens: 120_000,
    });

    expect(resolved.operatingWindowSource).toBe("thread");
    expect(resolved.operatingWindow).toBe(272_000);
    expect(resolved.effectiveOperatingWindow).toBe(120_000);
    expect(resolved.compactTriggerTokens).toBe(102_000);
  });

  it("computes compact trigger tokens from the configured percentage", () => {
    expect(getCompactTriggerTokens({
      operatingWindow: 200_000,
      compactAtPercent: 85,
    })).toBe(170_000);
  });
});
