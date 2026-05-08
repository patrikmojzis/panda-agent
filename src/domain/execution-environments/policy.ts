import {normalizeSkillKey} from "../agents/types.js";
import {isRecord} from "../../lib/records.js";
import type {ExecutionSkillPolicy} from "./types.js";

export function readExecutionSkillPolicy(context: unknown): ExecutionSkillPolicy {
  if (isRecord(context) && isRecord(context.executionEnvironment)) {
    const policy = context.executionEnvironment.skillPolicy;
    if (isRecord(policy)) {
      if (policy.mode === "all_agent" || policy.mode === "none") {
        return {mode: policy.mode};
      }
      if (policy.mode === "allowlist") {
        return {
          mode: "allowlist",
          skillKeys: Array.isArray(policy.skillKeys)
            ? policy.skillKeys
              .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
              .map((key) => normalizeSkillKey(key))
            : [],
        };
      }
    }
  }

  return {mode: "all_agent"};
}

export function isExecutionSkillAllowed(policy: ExecutionSkillPolicy, skillKey: string): boolean {
  if (policy.mode === "all_agent") {
    return true;
  }
  if (policy.mode === "none") {
    return false;
  }

  const normalized = normalizeSkillKey(skillKey);
  return policy.skillKeys.some((key) => normalizeSkillKey(key) === normalized);
}
