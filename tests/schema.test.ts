import { describe, expect, it } from "vitest";

import { formatParameters, z } from "../src/index.js";

describe("formatParameters", () => {
  it("matches Zod's native JSON schema output for standard objects", () => {
    const schema = z.object({
      name: z.string().describe("A display name"),
      nested: z.object({
        count: z.number(),
      }),
    });

    expect(formatParameters(schema)).toEqual(z.toJSONSchema(schema));
  });

  it("preserves open object semantics instead of forcing closed schemas", () => {
    const looseSchema = z.looseObject({
      name: z.string(),
    });
    const catchallSchema = z.object({
      name: z.string(),
    }).catchall(z.number());

    expect(formatParameters(looseSchema)).toEqual(z.toJSONSchema(looseSchema));
    expect(formatParameters(catchallSchema)).toEqual(z.toJSONSchema(catchallSchema));
  });
});
