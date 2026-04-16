import {z} from "zod";

import type {BrowserAction, BrowserLoadState, BrowserSnapshotMode} from "./browser-types.js";

function httpUrlSchema(fieldName = "url"): z.ZodString {
  return z.string().trim().url().superRefine((value, ctx) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} must use http:// or https://.`,
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldName} must be a valid URL.`,
      });
    }
  });
}

function optionalTimeoutSchema(): z.ZodOptional<z.ZodNumber> {
  return z.number().int().min(1).max(300_000).optional();
}

function requireRefOrSelector(
  value: {ref?: string; selector?: string},
  ctx: z.RefinementCtx,
): void {
  if (value.ref?.trim() || value.selector?.trim()) {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "ref or selector is required.",
  });
}

const browserLoadStateSchema = z.enum(["load", "domcontentloaded", "networkidle"]) satisfies z.ZodType<BrowserLoadState>;
const browserSnapshotModeSchema = z.enum(["compact", "full"]) satisfies z.ZodType<BrowserSnapshotMode>;

export const browserActionSchema = z.object({
  action: z.enum([
    "navigate",
    "snapshot",
    "click",
    "type",
    "press",
    "select",
    "wait",
    "evaluate",
    "screenshot",
    "pdf",
    "close",
  ]),
  url: httpUrlSchema().optional(),
  ref: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  key: z.string().trim().min(1).optional(),
  value: z.string().trim().min(1).optional(),
  values: z.array(z.string().trim().min(1)).min(1).optional(),
  loadState: browserLoadStateSchema.optional(),
  script: z.string().trim().min(1).optional(),
  arg: z.unknown().optional(),
  fullPage: z.boolean().optional(),
  labels: z.boolean().optional(),
  snapshotMode: browserSnapshotModeSchema.optional(),
  timeoutMs: optionalTimeoutSchema(),
}).superRefine((value, ctx) => {
  switch (value.action) {
    case "navigate":
      if (!value.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url is required for navigate.",
        });
      }
      return;
    case "snapshot":
    case "pdf":
    case "close":
      return;
    case "click":
      requireRefOrSelector(value, ctx);
      return;
    case "type":
      requireRefOrSelector(value, ctx);
      if (typeof value.text !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text is required for type.",
        });
      }
      return;
    case "press":
      if (!value.key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "key is required for press.",
        });
      }
      return;
    case "select":
      requireRefOrSelector(value, ctx);
      if (value.value || value.values?.length) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value or values is required.",
      });
      return;
    case "wait": {
      const count = [
        Boolean(value.loadState),
        Boolean(value.selector?.trim()),
        Boolean(value.text?.trim()),
        Boolean(value.url?.trim()),
      ].filter(Boolean).length;
      if (count !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "wait requires exactly one of loadState, selector, text, or url.",
        });
      }
      return;
    }
    case "evaluate":
      if (!value.script) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "script is required for evaluate.",
        });
      }
      return;
    case "screenshot":
      if (value.labels && (value.ref?.trim() || value.selector?.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "labels is only supported for whole-page screenshots.",
        });
      }
      return;
  }
});

export type BrowserActionInput = z.output<typeof browserActionSchema> & BrowserAction;
