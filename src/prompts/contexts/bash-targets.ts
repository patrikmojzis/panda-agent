export interface BashTargetContextItem {
  alias: string;
  isDefaultBinding?: boolean;
  allowedTools?: readonly string[];
  description?: string;
  capabilities?: readonly string[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function safeText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 160) {
    return null;
  }
  if (/https?:\/\/|\b(secret|token|password|authorization|bearer)\b/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function safeList(values: readonly string[] | undefined): string[] {
  return uniqueSorted((values ?? []).flatMap((value) => {
    const safe = safeText(value);
    return safe ? [safe] : [];
  }));
}

function renderTarget(item: BashTargetContextItem): string {
  const details: string[] = [];
  const description = item.description ? safeText(item.description) : null;
  if (description) {
    details.push(description);
  }
  const allowedTools = safeList(item.allowedTools);
  if (allowedTools.length > 0) {
    details.push(`tools: ${allowedTools.join(", ")}`);
  }
  const capabilities = safeList(item.capabilities);
  if (capabilities.length > 0) {
    details.push(`capabilities: ${capabilities.join(", ")}`);
  }
  if (item.isDefaultBinding) {
    details.push("session default");
  }

  return details.length > 0 ? `- ${item.alias}: ${details.join("; ")}` : `- ${item.alias}`;
}

export function renderBashTargetsContext(targets: readonly BashTargetContextItem[]): string {
  const byAlias = new Map<string, BashTargetContextItem>();
  byAlias.set("default", {alias: "default", description: "default session target"});
  for (const target of targets) {
    if (target.alias === "default") {
      continue;
    }
    byAlias.set(target.alias, target);
  }

  const renderedTargets = [...byAlias.values()]
    .sort((left, right) => left.alias === "default" ? -1 : right.alias === "default" ? 1 : left.alias.localeCompare(right.alias))
    .map(renderTarget);

  return ["Available bash targets:", ...renderedTargets].join("\n");
}
