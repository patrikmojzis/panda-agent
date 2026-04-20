import {
  DEFAULT_WIKI_SECTION_LEVEL,
  normalizeMarkdownLineEndings,
  parseMarkdownHeadingLine,
  trimMarkdownLeadingBlankLines,
  trimMarkdownOuterBlankLines,
  trimMarkdownTrailingBlankLines,
  upsertMarkdownSection,
} from "./markdown-sections.js";

export interface WikiImageAssetBlockInput {
  slot: string;
  assetPath: string;
  alt: string;
  caption?: string;
}

export interface MarkdownSectionAssetUpsertResult {
  content: string;
  sectionAction: "replaced" | "appended";
  blockAction: "replaced" | "appended";
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }

  return trimmed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]_*])/g, "\\$1");
}

function buildImageAssetSlotPattern(slot: string): RegExp {
  const escapedSlot = escapeRegex(slot);
  return new RegExp(
    `<!--\\s*panda:asset\\s+[^>]*slot="${escapedSlot}"[^>]*-->[\\s\\S]*?<!--\\s*\\/panda:asset\\s*-->`,
    "m",
  );
}

function buildImageAssetStartMarker(slot: string, assetPath: string): string {
  return `<!-- panda:asset slot="${escapeHtmlAttribute(slot)}" path="${escapeHtmlAttribute(assetPath)}" -->`;
}

function buildImageAssetEndMarker(): string {
  return "<!-- /panda:asset -->";
}

function buildImageAssetPathPattern(slot: string): RegExp {
  const escapedSlot = escapeRegex(slot);
  return new RegExp(
    `<!--\\s*panda:asset\\s+[^>]*slot="${escapedSlot}"[^>]*path="([^"]+)"[^>]*-->`,
    "m",
  );
}

export function findMarkdownImageAssetPath(document: string, slot: string): string | null {
  const normalizedDocument = normalizeMarkdownLineEndings(document);
  const normalizedSlot = requireTrimmed(slot, "Wiki asset slot");
  const match = buildImageAssetPathPattern(normalizedSlot).exec(normalizedDocument);
  if (!match?.[1]) {
    return null;
  }

  return match[1]
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function upsertSectionBodyAssetBlock(
  sectionBody: string,
  block: string,
  slot: string,
): {content: string; action: "replaced" | "appended"} {
  const normalizedBody = trimMarkdownOuterBlankLines(sectionBody);
  const pattern = buildImageAssetSlotPattern(slot);
  const match = pattern.exec(normalizedBody);

  if (!match || match.index < 0) {
    return {
      content: normalizedBody ? `${normalizedBody}\n\n${block}` : block,
      action: "appended",
    };
  }

  const before = trimMarkdownTrailingBlankLines(normalizedBody.slice(0, match.index));
  const after = trimMarkdownLeadingBlankLines(normalizedBody.slice(match.index + match[0].length));
  const parts = [
    ...(before ? [before] : []),
    block,
    ...(after ? [after] : []),
  ];

  return {
    content: parts.join("\n\n"),
    action: "replaced",
  };
}

export function buildMarkdownImageAssetBlock(input: WikiImageAssetBlockInput): string {
  const slot = requireTrimmed(input.slot, "Wiki asset slot");
  const assetPath = requireTrimmed(input.assetPath, "Wiki asset path");
  const alt = requireTrimmed(input.alt, "Wiki image alt text");
  const caption = input.caption?.trim();

  return [
    buildImageAssetStartMarker(slot, assetPath),
    `![${escapeMarkdownInline(alt)}](/${assetPath})`,
    ...(caption ? [`_${escapeMarkdownInline(caption)}_`] : []),
    buildImageAssetEndMarker(),
  ].join("\n");
}

export function upsertMarkdownSectionImageAsset(
  document: string,
  section: string,
  input: WikiImageAssetBlockInput,
  level = DEFAULT_WIKI_SECTION_LEVEL,
): MarkdownSectionAssetUpsertResult {
  const normalizedDocument = normalizeMarkdownLineEndings(document);
  const normalizedSection = requireTrimmed(section, "Wiki section");
  const block = buildMarkdownImageAssetBlock(input);
  const lines = normalizedDocument.split("\n");

  let startIndex = -1;
  let endIndex = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseMarkdownHeadingLine(lines[index] ?? "");
    if (!heading || heading.level !== level || heading.title !== normalizedSection) {
      continue;
    }

    startIndex = index;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextHeading = parseMarkdownHeadingLine(lines[nextIndex] ?? "");
      if (nextHeading && nextHeading.level <= level) {
        endIndex = nextIndex;
        break;
      }
    }
    break;
  }

  if (startIndex < 0) {
    const appended = upsertMarkdownSection(normalizedDocument, normalizedSection, block, level);
    return {
      content: appended.content,
      sectionAction: appended.action,
      blockAction: "appended",
    };
  }

  const updatedBody = upsertSectionBodyAssetBlock(
    lines.slice(startIndex + 1, endIndex).join("\n"),
    block,
    input.slot,
  );
  const prefix = trimMarkdownTrailingBlankLines(lines.slice(0, startIndex).join("\n"));
  const suffix = trimMarkdownLeadingBlankLines(lines.slice(endIndex).join("\n"));
  const sectionHeading = lines[startIndex] ?? `## ${normalizedSection}`;
  const sectionContent = [sectionHeading, "", updatedBody.content].join("\n");
  const parts = [
    ...(prefix ? [prefix] : []),
    sectionContent,
    ...(suffix ? [suffix] : []),
  ];

  return {
    content: parts.join("\n\n"),
    sectionAction: "replaced",
    blockAction: updatedBody.action,
  };
}
