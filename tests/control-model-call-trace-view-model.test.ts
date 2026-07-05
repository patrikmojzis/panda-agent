import {describe, expect, it} from "vitest";

import {
  buildModelCallTraceViewModel,
  formatSanitizedJson,
  previewForValue,
  sanitizeDisplayString,
} from "../apps/control-ui/src/features/control/model-calls/model-call-trace-view-model.ts";
import {
  buildDebugReport,
  extractBashExecutionDetails,
  modelCallFailureGroups,
  usageSummary,
  usageTokenCounts,
} from "../apps/control-ui/src/features/control/model-calls/model-call-display.ts";
import type {ModelCallTraceDetail, ModelCallTraceSummary} from "../apps/control-ui/src/lib/api.ts";

function sensitiveCacheValue(prefix = "trace-cache") {
  return `${prefix}:${["raw", "secret", "value"].join("-")}`;
}

function traceSummary(overrides: Partial<ModelCallTraceSummary>): ModelCallTraceSummary {
  return {
    id: "trace-default",
    runId: "run-1",
    threadId: "thread-1",
    sessionId: "session-1",
    agentKey: "panda",
    turn: 1,
    callIndex: 0,
    provider: "openai",
    model: "gpt-5",
    mode: "complete",
    status: "completed",
    startedAt: "2026-06-23T10:00:00.000Z",
    finishedAt: "2026-06-23T10:00:01.000Z",
    durationMs: 1000,
    promptCacheKey: null,
    usage: null,
    error: null,
    expiresAt: "2026-06-24T10:00:00.000Z",
    ...overrides,
  };
}

function traceDetail(overrides: Partial<ModelCallTraceDetail>): ModelCallTraceDetail {
  return {
    ...traceSummary(overrides),
    request: {},
    response: null,
    ...overrides,
  };
}

describe("Control model call trace view model", () => {
  it("pairs tool calls with results so operators do not match ids manually", () => {
    const model = buildModelCallTraceViewModel({
      id: "trace-1",
      status: "completed",
      request: {
        messages: [
          {role: "user", content: "Check the repo"},
          {
            role: "assistant",
            content: [
              {type: "text", text: "I will inspect it."},
              {
                type: "toolCall",
                id: "call_shell_1234567890",
                name: "bash",
                arguments: {command: "git status --short", cwd: "/workspace/panda-agent"},
                durationMs: 25,
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_shell_1234567890",
            toolName: "bash",
            content: [{type: "text", text: "## main\n"}],
            isError: false,
            durationMs: 140,
          },
        ],
      },
    });

    const toolSpan = model.spans.find((span) => span.kind === "tool");

    expect(model.summary.toolCalls).toBe(1);
    expect(model.summary.toolErrors).toBe(0);
    expect(toolSpan).toMatchObject({
      title: "bash",
      status: "ok",
      durationMs: 140,
      tool: {
        callId: "call_shell_1234567890",
        argumentsPreview: expect.stringContaining("git status --short"),
        resultPreview: expect.stringContaining("## main"),
      },
    });
    expect(toolSpan?.subtitle).toContain("paired with result");
  });

  it("surfaces failing tool spans as the default triage target", () => {
    const model = buildModelCallTraceViewModel({
      id: "trace-2",
      status: "failed",
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {type: "toolCall", id: "call_1", name: "http_json", arguments: {url: "https://example.test"}},
              {type: "toolCall", id: "call_2", name: "bash", arguments: {command: "exit 1"}},
            ],
          },
          {role: "toolResult", toolCallId: "call_1", toolName: "http_json", content: "ok", durationMs: 12},
          {role: "toolResult", toolCallId: "call_2", toolName: "bash", content: "exit code 1", isError: true, durationMs: 80},
        ],
      },
    });

    expect(model.summary.toolCalls).toBe(2);
    expect(model.summary.toolErrors).toBe(1);
    expect(model.summary.failingSpan?.title).toBe("bash");
    expect(model.summary.slowestSpan?.title).toBe("bash");
    expect(model.selectedDefaultId).toBe(model.summary.failingSpan?.id);
  });

  it("ranks triage targets by operator pain instead of timeline order", () => {
    const model = buildModelCallTraceViewModel({
      id: "trace-triage-queue",
      status: "failed",
      request: {
        systemPrompt: {text: "system prompt", truncated: true},
        messages: [
          {
            role: "assistant",
            content: [
              {type: "toolCall", id: "call_failed", name: "bash", arguments: {command: "exit 1"}},
              {type: "toolCall", id: "call_missing", name: "http_json", arguments: {url: "https://example.test"}},
              {type: "toolCall", id: "call_slow", name: "view_media", arguments: {path: "/tmp/file.png"}},
            ],
          },
          {role: "toolResult", toolCallId: "call_failed", toolName: "bash", content: "exit code 1", isError: true, durationMs: 20},
          {role: "toolResult", toolCallId: "call_slow", toolName: "view_media", content: "ok", durationMs: 900},
          {role: "toolResult", toolCallId: "call_orphan", toolName: "bash", content: "orphaned", durationMs: 15},
        ],
      },
    });

    expect(model.summary.triageItems.map((item) => item.label)).toEqual([
      "Failed tool",
      "Missing tool result",
      "Unmatched result",
      "Truncated payload",
      "Slowest span",
    ]);
    expect(model.summary.triageItems.map((item) => item.severity)).toEqual([
      "critical",
      "critical",
      "critical",
      "warning",
      "info",
    ]);
    expect(model.summary.triageItems[0]?.spanId).toContain("call_failed");
    expect(model.summary.triageItems.at(-1)?.spanId).toContain("call_slow");
  });

  it("includes the ranked triage queue in copied debug reports", () => {
    const rawPromptCacheKey = sensitiveCacheValue();
    const trace = traceDetail({
      id: "trace-report",
      status: "failed",
      error: {category: "provider_timeout", message: `timeout ${rawPromptCacheKey}`},
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {type: "toolCall", id: "call_failed", name: "bash", arguments: {command: `echo ${rawPromptCacheKey}`}},
            ],
          },
          {role: "toolResult", toolCallId: "call_failed", toolName: "bash", content: `error ${rawPromptCacheKey}`, isError: true, durationMs: 12},
        ],
      },
    });
    const model = buildModelCallTraceViewModel(trace);

    const report = buildDebugReport(trace, model, null);

    expect(report).toContain("triage:");
    expect(report).toContain("1. Failed tool");
    expect(report).toContain("span 1");
    expect(report).toContain(rawPromptCacheKey);
    expect(report).not.toContain("[redacted prompt-cache value]");
  });

  it("summarizes capture gaps operators need for trace debugging", () => {
    const model = buildModelCallTraceViewModel({
      id: "trace-debug-health",
      status: "failed",
      request: {
        systemPrompt: {promptCacheKey: sensitiveCacheValue()},
        messages: [
          {
            role: "assistant",
            content: [
              {type: "toolCall", id: "call_missing_result", name: "bash", arguments: {command: "pwd"}},
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_orphan_result",
            toolName: "bash",
            content: "orphaned result",
            truncated: true,
          },
        ],
      },
    });

    expect(model.summary).toMatchObject({
      pendingToolCalls: 1,
      redactedSpans: 1,
      truncatedSpans: 1,
      unmatchedToolResults: 1,
    });
  });

  it("redacts prompt cache fields in previews and raw JSON fallback", () => {
    const rawPromptCacheKey = sensitiveCacheValue();
    const value = {
      promptCacheKey: rawPromptCacheKey,
      nested: {prompt_cache_key: rawPromptCacheKey},
      safe: "visible",
    };

    expect(formatSanitizedJson(value)).toContain("visible");
    expect(formatSanitizedJson(value).includes(rawPromptCacheKey)).toBe(false);
    expect(previewForValue(value)?.includes(rawPromptCacheKey)).toBe(false);
    expect(formatSanitizedJson(value)).toContain("[redacted prompt-cache value]");
  });

  it("redacts prompt cache fields inside string previews without treating tokens as secrets", () => {
    const rawPromptCacheKey = sensitiveCacheValue();
    const jsonLikeString = `{"promptCacheKey":"${rawPromptCacheKey}"}`;
    const tokenText = `opaque ${rawPromptCacheKey}`;

    expect(previewForValue(jsonLikeString)?.includes(rawPromptCacheKey)).toBe(false);
    expect(formatSanitizedJson(jsonLikeString).includes(rawPromptCacheKey)).toBe(false);
    expect(sanitizeDisplayString(`stdout ${jsonLikeString}`).includes(rawPromptCacheKey)).toBe(false);
    expect(previewForValue(tokenText)).toContain(rawPromptCacheKey);
    expect(formatSanitizedJson(tokenText)).toContain(rawPromptCacheKey);
  });


  it("redacts prompt cache field fragments embedded in prose but preserves cache tokens", () => {
    const rawPromptCachePart = sensitiveCacheValue("context-cache");
    const prefixedJson = `stdout before ${JSON.stringify({promptCacheKeyPart: rawPromptCachePart})}`;
    const assignment = `promptCacheKeyPart=${rawPromptCachePart}`;
    const fingerprintAssignment = `prompt_cache_key_fingerprint=${rawPromptCachePart}`;
    const tokenPreview = `preview ${rawPromptCachePart}`;
    const nestedStdout = {details: {stdout: prefixedJson, stderr: `stderr ${assignment}`}};

    for (const rendered of [
      sanitizeDisplayString(prefixedJson),
      sanitizeDisplayString(assignment),
      sanitizeDisplayString(fingerprintAssignment),
      formatSanitizedJson(nestedStdout),
    ]) {
      expect(rendered.includes(rawPromptCachePart)).toBe(false);
      expect(rendered).toContain("[redacted prompt-cache value]");
    }

    expect(previewForValue(tokenPreview)).toContain(rawPromptCachePart);
  });


  it("redacts escaped prompt cache JSON fragments with arbitrary value prefixes", () => {
    const arbitraryValue = sensitiveCacheValue("custom");
    const escapedFragments = [
      JSON.stringify({promptCacheKey: arbitraryValue}).replaceAll('"', '\"'),
      JSON.stringify({promptCacheKeyPart: arbitraryValue}).replaceAll('"', '\"'),
      JSON.stringify({prompt_cache_key_fingerprint: arbitraryValue}).replaceAll('"', '\"'),
    ];

    for (const fragment of escapedFragments) {
      const rendered = sanitizeDisplayString(`stdout ${fragment}`);

      expect(rendered.includes(arbitraryValue)).toBe(false);
      expect(rendered).toContain("[redacted prompt-cache value]");
    }

    const nestedStdout = {details: {stdout: `stdout ${escapedFragments.join(" before ")}`}};
    expect(formatSanitizedJson(nestedStdout).includes(arbitraryValue)).toBe(false);
  });


  it("redacts malformed prompt cache values through uncertain lexical tails", () => {
    const suffix = ["after", "delimiter"].join("-");
    const spacedSuffix = ["after", "space"].join("-");
    const quoteValue = `prefix\"${suffix}`;
    const escapedQuoteValue = `prefix\\\"${suffix}`;
    const proseJson = `stdout ${JSON.stringify({promptCacheKey: quoteValue})} tail`;
    const escapedProseJson = `stdout ${JSON.stringify({promptCacheKeyPart: escapedQuoteValue}).replaceAll('"', '\"')} tail`;
    const assignment = `promptCacheKey=prefix ${spacedSuffix}`;

    for (const rendered of [
      sanitizeDisplayString(proseJson),
      sanitizeDisplayString(escapedProseJson),
      sanitizeDisplayString(assignment),
      formatSanitizedJson({details: {stdout: proseJson, stderr: assignment}}),
    ]) {
      expect(rendered.includes(suffix)).toBe(false);
      expect(rendered.includes(spacedSuffix)).toBe(false);
      expect(rendered).toContain("[redacted prompt-cache value]");
    }
  });


  it("redacts unicode-escaped prompt cache field names in prefixed string sinks", () => {
    const arbitraryValue = sensitiveCacheValue("custom");
    const unicodeFieldJson = `{${'"'}promptCache\u004bey${'"'}:${'"'}${arbitraryValue}${'"'}}`;
    const escapedUnicodeFieldJson = unicodeFieldJson.replaceAll('"', '\"');
    const partUnicodeFieldJson = `{${'"'}promptCache\u004beyPart${'"'}:${'"'}${arbitraryValue}${'"'}}`;
    const fingerprintUnicodeFieldJson = `{${'"'}prompt_cache_\u006bey_fingerprint${'"'}:${'"'}${arbitraryValue}${'"'}}`;

    for (const rendered of [
      sanitizeDisplayString(`stdout ${unicodeFieldJson}`),
      sanitizeDisplayString(`stdout ${escapedUnicodeFieldJson}`),
      sanitizeDisplayString(`stdout ${partUnicodeFieldJson}`),
      sanitizeDisplayString(`stdout ${fingerprintUnicodeFieldJson}`),
      formatSanitizedJson({details: {stdout: `stdout ${escapedUnicodeFieldJson}`}}),
    ]) {
      expect(rendered.includes(arbitraryValue)).toBe(false);
      expect(rendered.includes("[redacted prompt-cache value]")).toBe(true);
    }
  });


  it("redacts runtime-built unicode-escaped prompt cache field names in every string sink", () => {
    const bs = String.fromCharCode(92);
    const arbitraryValue = ["unicode", "key", "arbitrary", "value", "217"].join("-");
    const key = `promptCache${bs}u004bey`;
    const partKey = `promptCache${bs}u004beyPart`;
    const fingerprintKey = `prompt_cache_${bs}u006bey_fingerprint`;
    const raw = `stdout {"${key}":"${arbitraryValue}"}`;
    const escapedRaw = `stdout {${bs}"${key}${bs}":${bs}"${arbitraryValue}${bs}"}`;
    const partRaw = `stdout {"${partKey}":"${arbitraryValue}"}`;
    const fingerprintRaw = `stdout {"${fingerprintKey}":"${arbitraryValue}"}`;

    for (const rendered of [
      sanitizeDisplayString(raw),
      sanitizeDisplayString(escapedRaw),
      sanitizeDisplayString(partRaw),
      sanitizeDisplayString(fingerprintRaw),
      previewForValue(raw) ?? "",
      formatSanitizedJson({details: {stdout: raw, stderr: escapedRaw}}),
      formatSanitizedJson({outer: {details: {stdout: fingerprintRaw}}}),
    ]) {
      expect(rendered.includes(arbitraryValue)).toBe(false);
      expect(rendered.includes("[redacted prompt-cache value]")).toBe(true);
    }
  });


  it("redacts runtime-built unicode-escaped prompt cache object keys in raw JSON formatting", () => {
    const bs = String.fromCharCode(92);
    const arbitraryValue = ["structured", "object", "value", "217"].join("-");
    const key = `promptCache${bs}u004bey`;
    const partKey = `promptCache${bs}u004beyPart`;
    const fingerprintKey = `prompt_cache_${bs}u006bey_fingerprint`;

    const rendered = formatSanitizedJson({
      [key]: arbitraryValue,
      nested: {
        [partKey]: arbitraryValue,
        deeper: {[fingerprintKey]: arbitraryValue},
      },
    });

    expect(rendered.includes(arbitraryValue)).toBe(false);
    expect(rendered.match(/\[redacted prompt-cache value\]/g)?.length).toBe(3);
  });

  it("does not redact ordinary thread prose as a prompt cache token", () => {
    expect(sanitizeDisplayString("See thread:discussion for context")).toContain("thread:discussion");
    expect(sanitizeDisplayString("Use prompt-cache:visible-cache-key")).toContain("prompt-cache:visible-cache-key");
    expect(formatSanitizedJson({stdout: "trace-cache:visible-cache-key"})).toContain("trace-cache:visible-cache-key");
  });

  it("redacts prompt cache material inside bash stdout-style nested strings", () => {
    const rawPromptCacheKey = sensitiveCacheValue();
    const value = {details: {stdout: `{"promptCacheKey":"${rawPromptCacheKey}"}`}};

    const sanitized = formatSanitizedJson(value);

    expect(sanitized).toContain("stdout");
    expect(sanitized).toContain("[redacted prompt-cache value]");
    expect(sanitized.includes(rawPromptCacheKey)).toBe(false);
  });

  it("reads bash execution details from nested tool result payloads", () => {
    const details = extractBashExecutionDetails({
      toolName: "bash",
      toolArguments: {command: "pnpm typecheck", cwd: "/workspace/panda-agent"},
      result: {
        content: {
          details: {
            stdout: "",
            stderr: "Typecheck failed before provider call.",
            exitCode: 2,
            stderrChars: 39,
          },
        },
      },
      resultPayload: {
        details: {
          stdout: "",
          stderr: "Typecheck failed before provider call.",
          exitCode: 2,
          stderrChars: 39,
        },
      },
    });

    expect(details.looksLikeBash).toBe(true);
    expect(details.command).toBe("pnpm typecheck");
    expect(details.cwd).toBe("/workspace/panda-agent");
    expect(details.stderr).toBe("Typecheck failed before provider call.");
    expect(details.exitCode).toBe(2);
    expect(details.stderrChars).toBe(39);
  });

  it("summarizes provider-style usage token fields", () => {
    expect(usageSummary({
      input_tokens: 1200,
      output_tokens: 42,
      total_tokens: 1242,
    })).toBe("in 1,200 · out 42 · total 1,242");
  });

  it("extracts provider-style token counts for call diffs", () => {
    expect(usageTokenCounts({
      input_tokens: 1200,
      completionTokens: 42,
      total: 1242,
    })).toEqual({
      input: 1200,
      output: 42,
      total: 1242,
    });
  });

  it("groups repeated failed calls by provider, model, mode, and error label", () => {
    const groups = modelCallFailureGroups([
      traceSummary({
        id: "trace-old-timeout",
        status: "failed",
        startedAt: "2026-06-23T10:00:00.000Z",
        error: {category: "provider_timeout", message: "timeout on request a"},
      }),
      traceSummary({
        id: "trace-new-timeout",
        status: "failed",
        startedAt: "2026-06-23T10:01:00.000Z",
        error: {category: "provider_timeout", message: "timeout on request b"},
      }),
      traceSummary({
        id: "trace-schema",
        status: "failed",
        startedAt: "2026-06-23T10:02:00.000Z",
        error: {category: "tool_schema", message: "tool schema rejected"},
      }),
      traceSummary({id: "trace-ok", status: "completed"}),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      count: 2,
      label: "provider_timeout",
      representative: expect.objectContaining({id: "trace-new-timeout"}),
      summary: "timeout on request b",
    });
    expect(groups[1]).toMatchObject({count: 1, label: "tool_schema"});
  });
});
