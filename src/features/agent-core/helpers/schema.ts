import { z, type ZodType } from "zod";

import type { JsonObject } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTitles(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripTitles(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  delete value.title;
  for (const nested of Object.values(value)) {
    stripTitles(nested);
  }
}

function closeObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      closeObjectSchemas(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (value.type === "object" && !("additionalProperties" in value)) {
    value.additionalProperties = false;
  }

  for (const nested of Object.values(value)) {
    closeObjectSchemas(nested);
  }
}

export function formatParameters(schema: ZodType, _name?: string): JsonObject {
  const jsonSchema = z.toJSONSchema(schema) as JsonObject;

  stripTitles(jsonSchema);
  closeObjectSchemas(jsonSchema);

  return jsonSchema;
}
