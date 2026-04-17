import {resolveModelSelector} from "./model-selector.js";
import {resolveRuntimeDefaultModelSelector} from "./default-model.js";

export interface ModelContextPolicy {
  hardWindow: number;
  operatingWindow: number;
  compactAtPercent: number;
}

export interface ModelContextPolicyRule extends ModelContextPolicy {
  kind: "exact" | "prefix";
  match: string;
}

export interface ResolvedModelContextPolicy extends ModelContextPolicy {
  canonicalModel: string;
  modelId: string;
  match?: string;
  matchKind: "exact" | "prefix" | "fallback";
}

export interface ResolvedModelRuntimeBudget extends ResolvedModelContextPolicy {
  compactTriggerTokens: number;
}

export const DEFAULT_MODEL_CONTEXT_POLICY: ModelContextPolicy = {
  hardWindow: 1_000_000,
  operatingWindow: 200_000,
  compactAtPercent: 90,
};

export const MODEL_CONTEXT_POLICY_RULES: readonly ModelContextPolicyRule[] = [
  {
    kind: "prefix",
    match: "gpt-5",
    hardWindow: 1_050_000,
    operatingWindow: 272_000,
    compactAtPercent: 90,
  },
  {
    kind: "prefix",
    match: "claude-opus-4",
    hardWindow: 1_000_000,
    operatingWindow: 200_000,
    compactAtPercent: 90,
  },
  {
    kind: "prefix",
    match: "claude-sonnet-4",
    hardWindow: 1_000_000,
    operatingWindow: 200_000,
    compactAtPercent: 90,
  },
] as const;

function getDefaultCanonicalModel(): string {
  return resolveRuntimeDefaultModelSelector();
}

function sanitizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function resolveModelIdentity(value?: string): {canonicalModel: string; modelId: string} {
  const fallbackCanonicalModel = getDefaultCanonicalModel();
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    const fallback = resolveModelSelector(fallbackCanonicalModel);
    return {
      canonicalModel: fallback.canonical,
      modelId: fallback.modelId,
    };
  }

  try {
    const resolved = resolveModelSelector(trimmed);
    return {
      canonicalModel: resolved.canonical,
      modelId: resolved.modelId,
    };
  } catch {
    if (trimmed.includes("/")) {
      const separatorIndex = trimmed.indexOf("/");
      const modelId = trimmed.slice(separatorIndex + 1).trim();
      if (modelId) {
        return {
          canonicalModel: trimmed,
          modelId,
        };
      }
    }

    return {
      canonicalModel: trimmed,
      modelId: trimmed,
    };
  }
}

export function getCompactTriggerTokens(options: Pick<ModelContextPolicy, "operatingWindow" | "compactAtPercent">): number {
  const operatingWindow = sanitizePositiveInteger(options.operatingWindow) ?? DEFAULT_MODEL_CONTEXT_POLICY.operatingWindow;
  const compactAtPercent = sanitizePositiveInteger(options.compactAtPercent) ?? DEFAULT_MODEL_CONTEXT_POLICY.compactAtPercent;
  return Math.max(1, Math.floor((operatingWindow * compactAtPercent) / 100));
}

export function resolveModelContextPolicy(
  model?: string,
  options: {
    rules?: readonly ModelContextPolicyRule[];
    fallback?: ModelContextPolicy;
  } = {},
): ResolvedModelContextPolicy {
  const {canonicalModel, modelId} = resolveModelIdentity(model);
  const rules = options.rules ?? MODEL_CONTEXT_POLICY_RULES;
  const fallback = options.fallback ?? DEFAULT_MODEL_CONTEXT_POLICY;
  const exactMatch = rules.find((rule) => rule.kind === "exact" && rule.match === modelId);

  if (exactMatch) {
    return {
      canonicalModel,
      modelId,
      hardWindow: exactMatch.hardWindow,
      operatingWindow: exactMatch.operatingWindow,
      compactAtPercent: exactMatch.compactAtPercent,
      match: exactMatch.match,
      matchKind: "exact",
    };
  }

  const prefixMatch = rules.find((rule) => rule.kind === "prefix" && modelId.startsWith(rule.match));
  if (prefixMatch) {
    return {
      canonicalModel,
      modelId,
      hardWindow: prefixMatch.hardWindow,
      operatingWindow: prefixMatch.operatingWindow,
      compactAtPercent: prefixMatch.compactAtPercent,
      match: prefixMatch.match,
      matchKind: "prefix",
    };
  }

  return {
    canonicalModel,
    modelId,
    hardWindow: fallback.hardWindow,
    operatingWindow: fallback.operatingWindow,
    compactAtPercent: fallback.compactAtPercent,
    matchKind: "fallback",
  };
}

export function resolveModelRuntimeBudget(model?: string): ResolvedModelRuntimeBudget {
  const policy = resolveModelContextPolicy(model);

  return {
    ...policy,
    compactTriggerTokens: getCompactTriggerTokens({
      operatingWindow: policy.operatingWindow,
      compactAtPercent: policy.compactAtPercent,
    }),
  };
}
