import {describe, expect, it, vi} from "vitest";

import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {
  serializeThreadRuntimeJsonb,
  THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER,
} from "../src/domain/threads/runtime/postgres-jsonb-safety.js";

type ThreadRuntimePool = ConstructorParameters<typeof PostgresThreadRuntimeStore>[0]["pool"];

const NUL = "\0";
const NUL_PLACEHOLDER = THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER;

describe("thread runtime JSONB safety", () => {
  it("serializes runtime payloads with NUL placeholders without mutating callers", () => {
    const source = {
      text: `alpha${NUL}omega`,
      nested: {
        [`key${NUL}name`]: [
          `inner${NUL}value`,
          {
            newline: "kept\nintact",
            tab: "kept\tintact",
          },
        ],
      },
    };

    const serialized = serializeThreadRuntimeJsonb(source);

    expect(serialized.nulCount).toBe(3);
    expect(serialized.json).not.toBeNull();
    expect(serialized.json).not.toContain("\\u0000");
    expect(serialized.json).not.toContain(NUL);
    expect(JSON.parse(serialized.json ?? "null")).toEqual({
      text: `alpha${NUL_PLACEHOLDER}omega`,
      nested: {
        [`key${NUL_PLACEHOLDER}name`]: [
          `inner${NUL_PLACEHOLDER}value`,
          {
            newline: "kept\nintact",
            tab: "kept\tintact",
          },
        ],
      },
    });
    expect(source.text).toBe(`alpha${NUL}omega`);
    expect(Object.keys(source.nested)).toEqual([`key${NUL}name`]);
  });

  it("preserves undefined as SQL NULL at the boundary", () => {
    expect(serializeThreadRuntimeJsonb(undefined)).toEqual({
      json: null,
      nulCount: 0,
    });
    expect(serializeThreadRuntimeJsonb(null)).toEqual({
      json: "null",
      nulCount: 0,
    });
  });

  it("preserves own __proto__ keys while sanitizing NUL strings", () => {
    const nested = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nested, "__proto__", {
      value: `inner${NUL}value`,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, "__proto__", {
      value: {plain: "kept"},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    source.nested = nested;

    const serialized = serializeThreadRuntimeJsonb(source);
    const parsed = JSON.parse(serialized.json ?? "null") as Record<string, unknown>;
    const parsedNested = parsed.nested as Record<string, unknown>;

    expect(serialized.nulCount).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(parsed["__proto__"]).toEqual({plain: "kept"});
    expect(Object.prototype.hasOwnProperty.call(parsedNested, "__proto__")).toBe(true);
    expect(parsedNested["__proto__"]).toBe(`inner${NUL_PLACEHOLDER}value`);
    expect(Object.prototype.hasOwnProperty.call(source, "__proto__")).toBe(true);
    expect(nested["__proto__"]).toBe(`inner${NUL}value`);
  });

  it("redacts payload contents when Postgres still rejects runtime message JSONB", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => {
      throw new Error("unsupported Unicode escape sequence");
    });
    const pool: ThreadRuntimePool = {
      query,
      connect: async () => {
        throw new Error("connect should not be used by appendRuntimeMessage");
      },
    };
    const store = new PostgresThreadRuntimeStore({pool});
    const secret = `sekrit${NUL}contents`;

    const caught = await store.appendRuntimeMessage("thread-jsonb-error", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: secret }],
        api: "openai-responses",
        model: "openai/gpt-5.1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
      metadata: {
        note: secret,
      },
      source: "assistant",
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("Thread runtime JSONB persistence failed");
    expect(message).toContain("operation=appendRuntimeMessage");
    expect(message).toContain('table="runtime"."messages"');
    expect(message).toContain("metadata(nul=1)");
    expect(message).toContain("message(nul=1)");
    expect(message).toContain("payload=redacted");
    expect(message).not.toContain("sekrit");
    expect(message).not.toContain("contents");

    const params = query.mock.calls[0]?.[1];
    expect(params).toBeDefined();
    const boundJson = `${params?.[11] ?? ""}\n${params?.[12] ?? ""}`;
    expect(boundJson).toContain(NUL_PLACEHOLDER);
    expect(boundJson).not.toContain("\\u0000");
    expect(boundJson).not.toContain(NUL);
  });
});
