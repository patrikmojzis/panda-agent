import {z, type ZodType} from "zod";

import {isJsonObject, type JsonObject} from "./json.js";

export function requireJsonSchemaObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error("Zod JSON Schema output must be a JSON object.");
  }
  return value;
}

export function formatParameters(schema: ZodType): JsonObject {
  return requireJsonSchemaObject(z.toJSONSchema(schema));
}
