export interface WikiOverviewRecentEntry {
  title: string;
  path: string;
  updatedAt: string;
}

export interface WikiOverviewLinkedEntry {
  title: string;
  path: string;
  inboundLinks: number;
}

export function renderWikiOverviewContext(options: {
  namespacePath: string;
  refreshCadence?: string;
  recentlyEdited: WikiOverviewRecentEntry[];
  topLinked: WikiOverviewLinkedEntry[];
}): string {
  const lines = [
    `Namespace: ${options.namespacePath}`,
    "Allowed scope: only this namespace and its child pages.",
    options.refreshCadence
      ? `Overview snapshot refreshes every ${options.refreshCadence}.`
      : "Overview snapshot refreshes on demand.",
    "Overview only. Read pages on demand.",
    "",
    "Recently edited:",
  ];

  if (options.recentlyEdited.length === 0) {
    lines.push("- No pages yet.");
  } else {
    for (const page of options.recentlyEdited) {
      lines.push(`- ${page.title} :: ${page.path} (updated ${page.updatedAt})`);
    }
  }

  lines.push("", "Most linked:");
  if (options.topLinked.length === 0) {
    lines.push("- No inbound links yet.");
  } else {
    for (const page of options.topLinked) {
      const label = page.inboundLinks === 1 ? "1 inbound link" : `${page.inboundLinks} inbound links`;
      lines.push(`- ${page.title} :: ${page.path} (${label})`);
    }
  }

  return lines.join("\n");
}
