export interface WikiOverviewKeyPage {
  title: string;
  path: string;
}

export function renderWikiOverviewContext(options: {
  namespacePath: string;
  keyPages: readonly WikiOverviewKeyPage[];
}): string {
  const lines = [
    `Namespace: ${options.namespacePath}`,
    "Allowed scope: only this namespace and its child pages.",
    "Overview only. Read pages on demand.",
    "",
    "Key pages:",
  ];

  if (options.keyPages.length === 0) {
    lines.push("- No linked pages yet.");
  } else {
    for (const page of options.keyPages) {
      lines.push(`- ${page.title} :: ${page.path}`);
    }
  }

  lines.push(
    "",
    "Use `panda wiki overview` for recently edited pages and link details.",
    "Use `panda wiki search`, `panda wiki list`, and `panda wiki read` for deeper lookup.",
  );

  return lines.join("\n");
}
