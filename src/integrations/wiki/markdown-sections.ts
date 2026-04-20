export const DEFAULT_WIKI_SECTION_LEVEL = 2;

export interface MarkdownSectionUpsertResult {
  content: string;
  action: "replaced" | "appended";
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function trimOuterBlankLines(value: string): string {
  return normalizeLineEndings(value)
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

function trimLeadingBlankLines(value: string): string {
  return value.replace(/^(?:[ \t]*\n)+/, "");
}

function trimTrailingBlankLines(value: string): string {
  return value.replace(/(?:\n[ \t]*)+$/, "");
}

function requireHeadingTitle(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }

  return trimmed;
}

function parseHeadingLine(line: string): {level: number; title: string} | null {
  const match = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
  if (!match) {
    return null;
  }

  const marker = match[1];
  const title = match[2];
  if (!marker || !title) {
    return null;
  }

  return {
    level: marker.length,
    title: title.trim(),
  };
}

function buildSectionHeading(section: string, level: number): string {
  const title = requireHeadingTitle(section, "Wiki section");
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new Error("Wiki section level must be between 1 and 6.");
  }

  return `${"#".repeat(level)} ${title}`;
}

function buildSectionBlock(section: string, content: string, level: number): string {
  const heading = buildSectionHeading(section, level);
  const body = trimOuterBlankLines(content);
  return body ? `${heading}\n\n${body}` : heading;
}

export function buildMarkdownPageWithSection(
  title: string,
  section: string,
  content: string,
  level = DEFAULT_WIKI_SECTION_LEVEL,
): string {
  const pageTitle = requireHeadingTitle(title, "Wiki page title");
  const sectionBlock = buildSectionBlock(section, content, level);
  return `# ${pageTitle}\n\n${sectionBlock}`;
}

export function upsertMarkdownSection(
  document: string,
  section: string,
  content: string,
  level = DEFAULT_WIKI_SECTION_LEVEL,
): MarkdownSectionUpsertResult {
  const sectionBlock = buildSectionBlock(section, content, level);
  const normalizedDocument = normalizeLineEndings(document);
  const lines = normalizedDocument.split("\n");

  let startIndex = -1;
  let endIndex = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const headingLine = parseHeadingLine(lines[index] ?? "");
    if (!headingLine || headingLine.level !== level || headingLine.title !== section.trim()) {
      continue;
    }

    startIndex = index;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextHeading = parseHeadingLine(lines[nextIndex] ?? "");
      if (nextHeading && nextHeading.level <= level) {
        endIndex = nextIndex;
        break;
      }
    }
    break;
  }

  if (startIndex < 0) {
    const prefix = trimTrailingBlankLines(normalizedDocument);
    return {
      content: prefix ? `${prefix}\n\n${sectionBlock}` : sectionBlock,
      action: "appended",
    };
  }

  const prefix = trimTrailingBlankLines(lines.slice(0, startIndex).join("\n"));
  const suffix = trimLeadingBlankLines(lines.slice(endIndex).join("\n"));
  const parts = [
    ...(prefix ? [prefix] : []),
    sectionBlock,
    ...(suffix ? [suffix] : []),
  ];

  return {
    content: parts.join("\n\n"),
    action: "replaced",
  };
}
