export type BrowserExternalContentKind = "snapshot" | "evaluate";

export function wrapBrowserExternalContent(
  text: string,
  params: {kind: BrowserExternalContentKind},
): string {
  const kind = params.kind.trim() || "snapshot";
  return [
    `<<<EXTERNAL_UNTRUSTED_CONTENT source="browser" kind="${kind}">>>`,
    text,
    "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
  ].join("\n");
}

export function buildBrowserExternalContentDetails(
  kind: BrowserExternalContentKind,
): {
  untrusted: true;
  source: "browser";
  kind: BrowserExternalContentKind;
  wrapped: true;
} {
  return {
    untrusted: true,
    source: "browser",
    kind,
    wrapped: true,
  };
}
