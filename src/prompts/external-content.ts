function normalizeExternalContentLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^[a-z0-9_-]+$/i.test(trimmed) ? trimmed : fallback;
}

/** Wraps model-visible external text in prompt-injection guard markers. */
export function wrapExternalUntrustedContent(
  text: string,
  params: {source: string; kind?: string},
): string {
  const source = normalizeExternalContentLabel(params.source, "external");
  const kind = params.kind ? normalizeExternalContentLabel(params.kind, "content") : undefined;
  const attributes = [`source="${source}"`, ...(kind ? [`kind="${kind}"`] : [])];

  return [
    `<<<EXTERNAL_UNTRUSTED_CONTENT ${attributes.join(" ")}>>>`,
    text,
    "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
  ].join("\n");
}
