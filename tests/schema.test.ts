import {describe, expect, it} from "vitest";

import {requireJsonSchemaObject} from "../src/kernel/agent/helpers/schema.js";
import {formatParameters, z} from "../src/index.js";

describe("formatParameters", () => {
  it("does not force intentionally open object schemas closed", () => {
    const looseSchema = z.looseObject({
      name: z.string(),
    });
    const catchallSchema = z.object({
      name: z.string(),
    }).catchall(z.number());

    expect(formatParameters(looseSchema).additionalProperties).toEqual({});
    expect(formatParameters(catchallSchema).additionalProperties).toEqual({type: "number"});
  });

  it("rejects non-object schema output instead of casting it into the tool contract", () => {
    expect(() => requireJsonSchemaObject(null))
      .toThrow("Zod JSON Schema output must be a JSON object.");
  });
});
