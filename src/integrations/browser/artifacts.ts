import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import path from "node:path";

import type {Page} from "playwright-core";

import {withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {JsonObject} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {
  BrowserDeviceProfile,
  BrowserSessionScope,
  BrowserSnapshot,
} from "./action-types.js";
import {buildBrowserExternalContentDetails} from "./output.js";

export type BrowserArtifactSession = {
  scope: BrowserSessionScope;
  deviceProfile: BrowserDeviceProfile;
  device: JsonObject;
  runtimeDevice?: JsonObject;
  artifactDir: string;
};

export type BrowserArtifactSnapshot = {
  snapshot: BrowserSnapshot;
  text: string;
  truncated: boolean;
  elementCount: number;
};

function normalizeArtifactBytes(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function buildBrowserImagePayload(params: {
  bytes: Buffer;
  text: string;
  details: JsonObject;
}): ToolResultPayload {
  return {
    content: [
      {
        type: "text",
        text: params.text,
      },
      {
        type: "image",
        data: params.bytes.toString("base64"),
        mimeType: "image/png",
      },
    ],
    details: params.details,
  };
}

async function readPageTitle(page: Page): Promise<string> {
  return await page.title().catch(() => "");
}

/**
 * Writes a browser screenshot and returns the model-facing artifact payload.
 */
export async function buildBrowserScreenshotArtifactPayload(params: {
  session: BrowserArtifactSession;
  page: Page;
  bytes: Buffer | Uint8Array;
  labels: boolean;
  labeledSnapshot?: BrowserArtifactSnapshot | null;
}): Promise<ToolResultPayload> {
  const buffer = normalizeArtifactBytes(params.bytes);
  const filePath = path.join(params.session.artifactDir, `${Date.now()}-${randomUUID()}.png`);
  await writeFile(filePath, buffer);
  const title = await readPageTitle(params.page);
  const url = params.page.url();
  const textLines = [
    `Browser screenshot saved to ${filePath}`,
    ...(trimToUndefined(title) ? [`Page title: ${title}`] : []),
    `Page URL: ${url}`,
  ];
  const text = params.labels && params.labeledSnapshot
    ? `${textLines.join("\n")}\n\n${params.labeledSnapshot.text}`
    : textLines.join("\n");
  const details = withArtifactDetails({
    action: "screenshot",
    scope: params.session.scope,
    deviceProfile: params.session.deviceProfile,
    device: params.session.device,
    ...(params.session.runtimeDevice ? {runtimeDevice: params.session.runtimeDevice} : {}),
    path: filePath,
    mimeType: "image/png",
    bytes: buffer.length,
    url,
    title,
    ...(params.labels ? {labels: true} : {}),
    ...(params.labeledSnapshot
      ? {
          snapshotMode: "compact",
          truncated: params.labeledSnapshot.truncated,
          elementCount: params.labeledSnapshot.elementCount,
          signals: [...params.labeledSnapshot.snapshot.signals],
          elements: params.labeledSnapshot.snapshot.elements.map((element) => ({...element})),
          externalContent: buildBrowserExternalContentDetails("snapshot"),
        }
      : {}),
  }, {
    kind: "image",
    source: "browser",
    path: filePath,
    mimeType: "image/png",
    bytes: buffer.length,
  });
  return buildBrowserImagePayload({
    bytes: buffer,
    text,
    details,
  });
}

/**
 * Writes a browser PDF and returns the model-facing artifact payload.
 */
export async function buildBrowserPdfArtifactPayload(params: {
  session: BrowserArtifactSession;
  page: Page;
  bytes: Buffer | Uint8Array;
}): Promise<ToolResultPayload> {
  const buffer = normalizeArtifactBytes(params.bytes);
  const filePath = path.join(params.session.artifactDir, `${Date.now()}-${randomUUID()}.pdf`);
  await writeFile(filePath, buffer);
  const title = await readPageTitle(params.page);
  const url = params.page.url();
  return {
    content: [
      {
        type: "text",
        text: [
          `Browser PDF saved to ${filePath}`,
          ...(trimToUndefined(title) ? [`Page title: ${title}`] : []),
          `Page URL: ${url}`,
        ].join("\n"),
      },
    ],
    details: withArtifactDetails({
      action: "pdf",
      scope: params.session.scope,
      deviceProfile: params.session.deviceProfile,
      device: params.session.device,
      ...(params.session.runtimeDevice ? {runtimeDevice: params.session.runtimeDevice} : {}),
      path: filePath,
      mimeType: "application/pdf",
      bytes: buffer.length,
      url,
      title,
    } satisfies JsonObject, {
      kind: "pdf",
      source: "browser",
      path: filePath,
      mimeType: "application/pdf",
      bytes: buffer.length,
    }),
  };
}
