interface MessageTextPart {
  type: string;
  text?: unknown;
}

/** Extracts non-empty text blocks from provider-neutral message content. */
function extractMessageTextParts(content: readonly MessageTextPart[]): string[] {
  return content.flatMap((part) => {
    if (part.type !== "text" || typeof part.text !== "string") {
      return [];
    }

    const text = part.text.trim();
    return text ? [text] : [];
  });
}

/** Joins provider-neutral message text blocks with the caller's separator. */
export function joinMessageTextParts(content: readonly MessageTextPart[], separator = "\n\n"): string {
  return extractMessageTextParts(content).join(separator);
}
