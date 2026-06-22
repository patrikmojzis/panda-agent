import {describe, expect, it} from "vitest";

import {
  buildModelCallTraceViewModel,
  formatSanitizedJson,
  previewForValue,
  sanitizeDisplayString,
} from "../apps/control-ui/src/features/control/model-calls/model-call-trace-view-model.ts";

function sensitiveCacheValue(prefix = "trace-cache") {
  return `${prefix}:${["raw", "secret", "value"].join("-")}`;
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

  it("redacts prompt cache material embedded inside string previews", () => {
    const rawPromptCacheKey = sensitiveCacheValue();
    const jsonLikeString = `{"promptCacheKey":"${rawPromptCacheKey}"}`;

    expect(previewForValue(jsonLikeString)?.includes(rawPromptCacheKey)).toBe(false);
    expect(formatSanitizedJson(jsonLikeString).includes(rawPromptCacheKey)).toBe(false);
    expect(sanitizeDisplayString(`stdout ${jsonLikeString}`).includes(rawPromptCacheKey)).toBe(false);
    expect(previewForValue(`opaque ${rawPromptCacheKey}`)?.includes(rawPromptCacheKey)).toBe(false);
  });


  it("redacts prompt cache part and fingerprint material embedded in prose", () => {
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
      previewForValue(tokenPreview) ?? "",
      formatSanitizedJson(nestedStdout),
    ]) {
      expect(rendered.includes(rawPromptCachePart)).toBe(false);
      expect(rendered).toContain("[redacted prompt-cache value]");
    }
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
  });

  it("redacts prompt cache material inside bash stdout-style nested strings", () => {
    const rawPromptCacheKey = sensitiveCacheValue();
    const value = {details: {stdout: `{"promptCacheKey":"${rawPromptCacheKey}"}`}};

    const sanitized = formatSanitizedJson(value);

    expect(sanitized).toContain("stdout");
    expect(sanitized).toContain("[redacted prompt-cache value]");
    expect(sanitized.includes(rawPromptCacheKey)).toBe(false);
  });
});
