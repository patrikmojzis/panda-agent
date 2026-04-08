import { marked, type Token } from "marked";

const RESET = "\u001b[0m";

type InlineStyle = "bold" | "italic" | "code" | "heading" | "link" | "quote";

type StyledSegment = {
  text: string;
  styles: readonly InlineStyle[];
};

type InlinePiece =
  | { type: "segment"; segment: StyledSegment }
  | { type: "break" };

type WrapToken =
  | { type: "space" }
  | { type: "break" }
  | { type: "text"; text: string; styles: readonly InlineStyle[]; breakable: boolean };

// `flow` blocks are wrapped prose/list content. `pre` blocks preserve line breaks verbatim.
type MarkdownBlock =
  | { type: "blank" }
  | {
    type: "flow";
    pieces: readonly InlinePiece[];
    firstPrefix: readonly StyledSegment[];
    continuationPrefix: readonly StyledSegment[];
  }
  | {
    type: "pre";
    lines: readonly (readonly StyledSegment[])[];
    firstPrefix: readonly StyledSegment[];
    continuationPrefix: readonly StyledSegment[];
  };

interface MarkdownLine {
  plain: string;
  rendered: string;
}

const EMPTY_STYLES: readonly InlineStyle[] = [];
const EMPTY_SEGMENTS: readonly StyledSegment[] = [];
const MARKDOWN_SYNTAX_RE = /[#*_`>|[\]-]|\n\n|^\d+\. |\n\d+\. /;

function createSegment(text: string, styles: readonly InlineStyle[] = EMPTY_STYLES): StyledSegment {
  return { text, styles };
}

function createTextPiece(text: string, styles: readonly InlineStyle[] = EMPTY_STYLES): InlinePiece {
  return { type: "segment", segment: createSegment(text, styles) };
}

function isBreakPiece(piece: InlinePiece): piece is Extract<InlinePiece, { type: "break" }> {
  return piece.type === "break";
}

function mergeStyles(
  styles: readonly InlineStyle[],
  extra: InlineStyle,
): readonly InlineStyle[] {
  return styles.includes(extra) ? styles : [...styles, extra];
}

function applyStyleToPieces(
  pieces: readonly InlinePiece[],
  style: InlineStyle,
): InlinePiece[] {
  return pieces.map((piece) => {
    if (isBreakPiece(piece)) {
      return piece;
    }

    return {
      type: "segment",
      segment: {
        text: piece.segment.text,
        styles: mergeStyles(piece.segment.styles, style),
      },
    };
  });
}

function renderStyledText(text: string, styles: readonly InlineStyle[]): string {
  if (!text || styles.length === 0) {
    return text;
  }

  const codes = new Set<string>();

  if (styles.includes("bold") || styles.includes("heading")) {
    codes.add("1");
  }

  if (styles.includes("italic")) {
    codes.add("3");
  }

  if (styles.includes("code")) {
    codes.add("38;5;221");
  }

  if (styles.includes("link")) {
    codes.add("4");
    codes.add("38;5;44");
  }

  if (styles.includes("quote")) {
    codes.add("38;5;244");
  }

  if (codes.size === 0) {
    return text;
  }

  return `\u001b[${[...codes].join(";")}m${text}${RESET}`;
}

function renderLine(segments: readonly StyledSegment[]): MarkdownLine {
  return {
    plain: segments.map((segment) => segment.text).join(""),
    rendered: segments.map((segment) => renderStyledText(segment.text, segment.styles)).join(""),
  };
}

function plainLength(segments: readonly StyledSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0);
}

function hardWrapSegments(
  segments: readonly StyledSegment[],
  width: number,
): StyledSegment[][] {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const lines: StyledSegment[][] = [[]];

  for (const segment of segments) {
    if (!segment.text) {
      continue;
    }

    let remaining = segment.text;
    while (remaining.length > 0) {
      const currentLine = lines[lines.length - 1] ?? [];
      const currentWidth = plainLength(currentLine);
      const available = Math.max(1, normalizedWidth - currentWidth);
      const chunk = remaining.slice(0, available);
      currentLine.push({
        text: chunk,
        styles: segment.styles,
      });
      remaining = remaining.slice(chunk.length);

      if (remaining.length > 0) {
        lines.push([]);
      }
    }
  }

  return lines;
}

function createFlowBlock(
  pieces: readonly InlinePiece[],
  firstPrefix: readonly StyledSegment[] = EMPTY_SEGMENTS,
  continuationPrefix: readonly StyledSegment[] = EMPTY_SEGMENTS,
): MarkdownBlock {
  return {
    type: "flow",
    pieces,
    firstPrefix,
    continuationPrefix,
  };
}

function createPreBlock(
  lines: readonly (readonly StyledSegment[])[],
  firstPrefix: readonly StyledSegment[] = EMPTY_SEGMENTS,
  continuationPrefix: readonly StyledSegment[] = EMPTY_SEGMENTS,
): MarkdownBlock {
  return {
    type: "pre",
    lines,
    firstPrefix,
    continuationPrefix,
  };
}

function prefixBlocks(
  blocks: readonly MarkdownBlock[],
  firstPrefix: readonly StyledSegment[],
  continuationPrefix: readonly StyledSegment[],
): MarkdownBlock[] {
  const prefixed: MarkdownBlock[] = [];
  let firstContentBlock = true;

  for (const block of blocks) {
    if (block.type === "blank") {
      prefixed.push(block);
      continue;
    }

    const leadingPrefix = firstContentBlock ? firstPrefix : continuationPrefix;
    firstContentBlock = false;

    if (block.type === "flow") {
      prefixed.push({
        type: "flow",
        pieces: block.pieces,
        firstPrefix: [...leadingPrefix, ...block.firstPrefix],
        continuationPrefix: [...continuationPrefix, ...block.continuationPrefix],
      });
      continue;
    }

    prefixed.push({
      type: "pre",
      lines: block.lines,
      firstPrefix: [...leadingPrefix, ...block.firstPrefix],
      continuationPrefix: [...continuationPrefix, ...block.continuationPrefix],
    });
  }

  return prefixed;
}

function normalizeBlocks(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  const normalized: MarkdownBlock[] = [];

  for (const block of blocks) {
    if (block.type === "blank") {
      if (normalized.length === 0 || normalized.at(-1)?.type === "blank") {
        continue;
      }
    }

    normalized.push(block);
  }

  while (normalized[0]?.type === "blank") {
    normalized.shift();
  }

  while (normalized.at(-1)?.type === "blank") {
    normalized.pop();
  }

  return normalized;
}

function tokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens)
    ? token.tokens as Token[]
    : [];
}

function buildInlinePieces(tokens: readonly Token[]): InlinePiece[] {
  const pieces: InlinePiece[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const children = tokenChildren(token);
        if (children.length > 0) {
          pieces.push(...buildInlinePieces(children));
        } else if ("text" in token && token.text) {
          pieces.push(createTextPiece(token.text));
        }
        break;
      }

      case "strong":
        pieces.push(...applyStyleToPieces(buildInlinePieces(tokenChildren(token)), "bold"));
        break;

      case "em":
        pieces.push(...applyStyleToPieces(buildInlinePieces(tokenChildren(token)), "italic"));
        break;

      case "codespan":
        pieces.push(createTextPiece(token.text, ["code"]));
        break;

      case "link": {
        const labelPieces = applyStyleToPieces(buildInlinePieces(tokenChildren(token)), "link");
        const labelText = labelPieces.flatMap((piece) => {
          return isBreakPiece(piece) ? [] : [piece.segment.text];
        }).join("");

        if (!labelText || labelText === token.href) {
          pieces.push(createTextPiece(token.href, ["link"]));
          break;
        }

        pieces.push(...labelPieces);
        pieces.push(createTextPiece(" ("));
        pieces.push(createTextPiece(token.href, ["link"]));
        pieces.push(createTextPiece(")"));
        break;
      }

      case "br":
        pieces.push({ type: "break" });
        break;

      case "image": {
        const label = token.text?.trim();
        if (label && token.href) {
          pieces.push(createTextPiece(`${label} (${token.href})`, ["link"]));
        } else if (token.href) {
          pieces.push(createTextPiece(token.href, ["link"]));
        } else if (label) {
          pieces.push(createTextPiece(label));
        }
        break;
      }

      case "escape":
        pieces.push(createTextPiece(token.text));
        break;

      case "del":
        pieces.push(...buildInlinePieces(tokenChildren(token)));
        break;

      default: {
        const children = tokenChildren(token);
        if (children.length > 0) {
          pieces.push(...buildInlinePieces(children));
          break;
        }

        if ("text" in token && typeof token.text === "string" && token.text) {
          pieces.push(createTextPiece(token.text));
          break;
        }

        if ("raw" in token && typeof token.raw === "string" && token.raw) {
          pieces.push(createTextPiece(token.raw));
        }
      }
    }
  }

  return pieces;
}

function buildMarkdownBlocks(tokens: readonly Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "space":
        blocks.push({ type: "blank" });
        break;

      case "paragraph":
        blocks.push(createFlowBlock(buildInlinePieces(tokenChildren(token))));
        blocks.push({ type: "blank" });
        break;

      case "text": {
        const children = tokenChildren(token);
        if (children.length > 0) {
          blocks.push(createFlowBlock(buildInlinePieces(children)));
          blocks.push({ type: "blank" });
        } else if ("text" in token && token.text.trim()) {
          blocks.push(createFlowBlock([createTextPiece(token.text)]));
          blocks.push({ type: "blank" });
        }
        break;
      }

      case "heading":
        blocks.push(createFlowBlock(
          applyStyleToPieces(buildInlinePieces(tokenChildren(token)), "heading"),
        ));
        blocks.push({ type: "blank" });
        break;

      case "blockquote": {
        const children = normalizeBlocks(buildMarkdownBlocks(tokenChildren(token)));
        const quoted = prefixBlocks(
          children,
          [createSegment("> ", ["quote"])],
          [createSegment("> ", ["quote"])],
        );
        blocks.push(...quoted);
        blocks.push({ type: "blank" });
        break;
      }

      case "list": {
        const start = token.start ?? 1;
        for (const [index, item] of token.items.entries()) {
          const childBlocks = normalizeBlocks(buildMarkdownBlocks(item.tokens as Token[]));
          const itemBlocks = childBlocks.length > 0
            ? childBlocks
            : [createFlowBlock([createTextPiece(item.text ?? "")])];
          const marker = token.ordered ? `${start + index}. ` : "- ";
          blocks.push(...prefixBlocks(
            itemBlocks,
            [createSegment(marker)],
            [createSegment(" ".repeat(marker.length))],
          ));
        }
        blocks.push({ type: "blank" });
        break;
      }

      case "code": {
        const rawLines = token.text.replace(/\t/g, "  ").split("\n");
        const lines = rawLines.map((line: string) => [createSegment(line, ["code"])]);
        blocks.push(createPreBlock(
          lines.length > 0 ? lines : [[createSegment("", ["code"])]],
          [createSegment("  ")],
          [createSegment("  ")],
        ));
        blocks.push({ type: "blank" });
        break;
      }

      case "hr":
        blocks.push(createFlowBlock([
          createTextPiece("---", ["quote"]),
        ]));
        blocks.push({ type: "blank" });
        break;

      case "table":
        blocks.push(createPreBlock(
          token.raw.trimEnd().split("\n").map((line) => [createSegment(line, ["code"])]),
          [createSegment("  ")],
          [createSegment("  ")],
        ));
        blocks.push({ type: "blank" });
        break;

      default: {
        const children = tokenChildren(token);
        if (children.length > 0) {
          blocks.push(...buildMarkdownBlocks(children));
          break;
        }

        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          blocks.push(createFlowBlock([createTextPiece(token.text)]));
          blocks.push({ type: "blank" });
          break;
        }

        if ("raw" in token && typeof token.raw === "string" && token.raw.trim()) {
          blocks.push(createFlowBlock([createTextPiece(token.raw.trim())]));
          blocks.push({ type: "blank" });
        }
      }
    }
  }

  return blocks;
}

function tokenizeFlowPieces(pieces: readonly InlinePiece[]): WrapToken[] {
  const tokens: WrapToken[] = [];

  for (const piece of pieces) {
    if (isBreakPiece(piece)) {
      tokens.push({ type: "break" });
      continue;
    }

    const { segment } = piece;
    if (!segment.text) {
      continue;
    }

    if (segment.styles.includes("code")) {
      tokens.push({
        type: "text",
        text: segment.text.replace(/\t/g, "  "),
        styles: segment.styles,
        breakable: false,
      });
      continue;
    }

    for (const chunk of segment.text.split(/(\s+)/)) {
      if (!chunk) {
        continue;
      }

      if (/^\s+$/.test(chunk)) {
        tokens.push({ type: "space" });
        continue;
      }

      tokens.push({
        type: "text",
        text: chunk,
        styles: segment.styles,
        breakable: true,
      });
    }
  }

  return tokens;
}

function renderWrappedBlock(block: Extract<MarkdownBlock, { type: "flow" }>, width: number): MarkdownLine[] {
  const tokens = tokenizeFlowPieces(block.pieces);
  if (tokens.length === 0) {
    return [];
  }

  const lines: MarkdownLine[] = [];
  let currentPrefix = block.firstPrefix;
  let currentSegments: StyledSegment[] = [...currentPrefix];
  let currentWidth = plainLength(currentPrefix);
  let hasContent = false;
  let pendingSpace = false;

  const resetLine = (prefix: readonly StyledSegment[]): void => {
    currentPrefix = prefix;
    currentSegments = [...prefix];
    currentWidth = plainLength(prefix);
    hasContent = false;
    pendingSpace = false;
  };

  const commitLine = (): void => {
    lines.push(renderLine(currentSegments));
    resetLine(block.continuationPrefix);
  };

  const appendSegment = (segment: StyledSegment): void => {
    if (!segment.text) {
      return;
    }

    currentSegments.push(segment);
    currentWidth += segment.text.length;
    hasContent = true;
  };

  const ensurePendingSpace = (): void => {
    if (!pendingSpace || !hasContent) {
      pendingSpace = false;
      return;
    }

    if (currentWidth + 1 > width) {
      commitLine();
    }

    appendSegment(createSegment(" "));
    pendingSpace = false;
  };

  const appendTextToken = (token: Extract<WrapToken, { type: "text" }>): void => {
    const maxFreshWidth = Math.max(1, width - plainLength(block.continuationPrefix));
    let remaining = token.text;

    while (remaining.length > 0) {
      if (token.breakable && hasContent && remaining.length <= maxFreshWidth) {
        const neededWidth = remaining.length + (pendingSpace && hasContent ? 1 : 0);
        if (currentWidth + neededWidth > width) {
          commitLine();
          continue;
        }
      }

      ensurePendingSpace();

      const available = Math.max(1, width - currentWidth);
      const take = Math.min(available, remaining.length);
      appendSegment({
        text: remaining.slice(0, take),
        styles: token.styles,
      });
      remaining = remaining.slice(take);

      if (remaining.length > 0) {
        commitLine();
      }
    }
  };

  for (const token of tokens) {
    if (token.type === "space") {
      pendingSpace = pendingSpace || hasContent;
      continue;
    }

    if (token.type === "break") {
      if (hasContent) {
        commitLine();
      } else {
        resetLine(block.continuationPrefix);
      }
      continue;
    }

    appendTextToken(token);
  }

  if (hasContent) {
    lines.push(renderLine(currentSegments));
  }

  return lines;
}

function renderPreformattedBlock(block: Extract<MarkdownBlock, { type: "pre" }>, width: number): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let firstRenderedLine = true;

  for (const rawLine of block.lines) {
    const prefix = firstRenderedLine ? block.firstPrefix : block.continuationPrefix;
    const availableWidth = Math.max(1, width - plainLength(prefix));
    const wrapped = rawLine.length > 0
      ? hardWrapSegments(rawLine, availableWidth)
      : [[]];

    for (const [index, slice] of wrapped.entries()) {
      const currentPrefix = firstRenderedLine && index === 0
        ? block.firstPrefix
        : block.continuationPrefix;
      lines.push(renderLine([...currentPrefix, ...slice]));
      firstRenderedLine = false;
    }
  }

  return lines;
}

function renderPlainLines(markdown: string, width: number): MarkdownLine[] {
  const blocks = markdown.split("\n").map<MarkdownBlock>((line) => {
    return line.length === 0
      ? { type: "blank" }
      : createFlowBlock([createTextPiece(line)]);
  });

  return normalizeBlocks(blocks).flatMap((block) => {
    if (block.type === "blank") {
      return [{ plain: "", rendered: "" }];
    }

    return block.type === "flow"
      ? renderWrappedBlock(block, width)
      : renderPreformattedBlock(block, width);
  });
}

export function renderMarkdownLines(markdown: string, width: number): MarkdownLine[] {
  if (!markdown.trim()) {
    return [];
  }

  if (!MARKDOWN_SYNTAX_RE.test(markdown)) {
    return renderPlainLines(markdown, width);
  }

  const tokens = marked.lexer(markdown) as Token[];
  const blocks = normalizeBlocks(buildMarkdownBlocks(tokens));
  const lines: MarkdownLine[] = [];

  for (const block of blocks) {
    if (block.type === "blank") {
      lines.push({ plain: "", rendered: "" });
      continue;
    }

    if (block.type === "flow") {
      lines.push(...renderWrappedBlock(block, width));
      continue;
    }

    lines.push(...renderPreformattedBlock(block, width));
  }

  return lines;
}
