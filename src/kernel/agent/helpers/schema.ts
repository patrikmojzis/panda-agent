import {z, type ZodType} from "zod";

import type {JsonObject} from "../types.js";

export function formatParameters(schema: ZodType): JsonObject {
  return z.toJSONSchema(schema) as JsonObject;
}
