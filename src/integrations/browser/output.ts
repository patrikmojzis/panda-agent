import {wrapExternalUntrustedContent} from "../../prompts/external-content.js";

export type BrowserExternalContentKind = "snapshot" | "evaluate";

export function wrapBrowserExternalContent(
  text: string,
  params: {kind: BrowserExternalContentKind},
): string {
  const kind = params.kind.trim() || "snapshot";
  return wrapExternalUntrustedContent(text, {source: "browser", kind});
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
