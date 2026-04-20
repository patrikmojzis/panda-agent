import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import {resolveAgentMediaDir, resolveMediaDir} from "../../app/runtime/data-dir.js";
import {resolveContextPath} from "../../app/runtime/panda-path-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {assertPathReadable} from "../../lib/fs.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
  DEFAULT_WIKI_LOCALE,
  resolveWikiUrl,
  WikiJsClient,
  type WikiPage,
  type WikiPageListItem,
  type WikiPageSearchResult,
} from "../../integrations/wiki/client.js";
import {
  buildMarkdownImageAssetBlock,
  findMarkdownImageAssetPath,
  upsertMarkdownSectionImageAsset,
} from "../../integrations/wiki/asset-blocks.js";
import {
  buildWikiArchiveRoot,
  buildWikiAssetRoot,
  buildWikiPageAssetDirectory,
  hasUnsafeWikiPathSegments,
  isArchivedWikiPath,
  isWikiAssetPathWithinNamespace,
  isWikiPathWithinNamespace,
  stripWikiLocalePrefix,
  trimWikiPath,
} from "../../integrations/wiki/paths.js";
import {retargetWikiLinks, rewriteRelativeWikiLinksForMovedPage,} from "../../integrations/wiki/link-rewrite.js";
import {buildMarkdownPageWithSection, upsertMarkdownSection,} from "../../integrations/wiki/markdown-sections.js";
import {buildTextToolPayload} from "./shared.js";

export interface WikiToolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  bindings?: Pick<WikiBindingService, "getBinding">;
}

function readScope(context: unknown): {agentKey: string} {
  if (!isRecord(context) || typeof context.agentKey !== "string" || !context.agentKey.trim()) {
    throw new ToolError("wiki requires agentKey in the current runtime session context.");
  }

  return {
    agentKey: context.agentKey.trim(),
  };
}

function normalizePath(value: string): string {
  const trimmed = trimWikiPath(value);
  if (!trimmed) {
    throw new ToolError("wiki path must not be empty.");
  }
  if (hasUnsafeWikiPathSegments(trimmed)) {
    throw new ToolError(`wiki path must not contain empty, '.' , or '..' segments (${value}).`);
  }
  return trimmed;
}

function normalizeLocale(value: string | undefined): string {
  return trimToUndefined(value) ?? DEFAULT_WIKI_LOCALE;
}

function normalizeSectionTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError("wiki section must not be empty.");
  }

  return trimmed;
}

function normalizeAssetSlot(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new ToolError("wiki attach_image slot must not be empty.");
  }

  return normalized;
}

function normalizeImageText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError(`wiki attach_image ${label} must not be empty.`);
  }

  return trimmed;
}

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

const VIEWABLE_WIKI_ASSET_MIME_BY_EXTENSION = new Map<string, string>([
  ...IMAGE_MIME_BY_EXTENSION.entries(),
  [".pdf", "application/pdf"],
]);

function inferImageFile(filePath: string): {extension: string; mimeType: string} | null {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXTENSION.get(extension);
  if (!mimeType) {
    return null;
  }

  return {
    extension,
    mimeType,
  };
}

function inferViewableWikiAssetMimeType(assetPath: string, headerMimeType: string | undefined): string | null {
  const normalizedHeaderMimeType = trimToUndefined(headerMimeType)?.toLowerCase();
  if (normalizedHeaderMimeType) {
    if (normalizedHeaderMimeType === "application/pdf" || normalizedHeaderMimeType.startsWith("image/")) {
      return normalizedHeaderMimeType;
    }

    return null;
  }

  return VIEWABLE_WIKI_ASSET_MIME_BY_EXTENSION.get(path.extname(assetPath).toLowerCase()) ?? null;
}

function resolveWikiAssetMediaRoot(context: DefaultAgentSessionContext | undefined, env: NodeJS.ProcessEnv): string {
  const agentKey = trimToUndefined(context?.agentKey);
  if (agentKey) {
    return resolveAgentMediaDir(agentKey, env);
  }

  return resolveMediaDir(env);
}

async function writeFetchedWikiAsset(
  assetPath: string,
  bytes: Uint8Array,
  context: DefaultAgentSessionContext | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const root = path.join(resolveWikiAssetMediaRoot(context, env), "wiki", "fetched");
  const destination = path.join(root, ...assetPath.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolError(`Wiki asset path ${assetPath} resolved outside Panda media storage.`);
  }

  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, bytes);
  return destination;
}

function buildWikiImageAssetFilename(slot: string, extension: string): string {
  return `${slot}${extension}`;
}

function splitWikiAssetPath(assetPath: string): {directoryPath: string; filename: string} {
  const separatorIndex = assetPath.lastIndexOf("/");
  if (separatorIndex < 0) {
    return {
      directoryPath: "",
      filename: assetPath,
    };
  }

  return {
    directoryPath: assetPath.slice(0, separatorIndex),
    filename: assetPath.slice(separatorIndex + 1),
  };
}

function buildArchivePath(path: string, namespacePath: string, now = new Date()): string {
  if (isArchivedWikiPath(path, namespacePath)) {
    throw new ToolError(`Wiki page ${path} is already archived.`);
  }

  const leaf = path.split("/").filter(Boolean).at(-1) ?? "page";
  const safeLeaf = leaf.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "page";
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();

  return `${buildWikiArchiveRoot(namespacePath)}/${year}/${month}/${safeLeaf}-${timestamp}`;
}

function assertNamespacePath(path: string, namespacePath: string): void {
  if (!isWikiPathWithinNamespace(path, namespacePath)) {
    throw new ToolError(
      `Wiki path ${path} is outside the agent namespace ${namespacePath}. Use only ${namespacePath} or its children, for example ${namespacePath}/profile.`,
    );
  }
}

function assertNamespaceAssetPath(path: string, namespacePath: string): void {
  const assetRoot = buildWikiAssetRoot(namespacePath);
  if (!isWikiAssetPathWithinNamespace(path, namespacePath)) {
    throw new ToolError(
      `Wiki asset path ${path} is outside the agent asset namespace ${assetRoot}. Use only ${assetRoot} or its children.`,
    );
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const INTERNAL_LIST_SCAN_LIMIT = 1000;

function formatPageText(page: WikiPage): string {
  const lines = [
    `# ${page.title}`,
    `Path: ${page.locale}/${page.path}`,
    `Updated: ${page.updatedAt}`,
  ];

  if (page.description) {
    lines.push(`Description: ${page.description}`);
  }
  if (page.tags.length > 0) {
    lines.push(`Tags: ${page.tags.join(", ")}`);
  }

  lines.push("");
  lines.push(page.content);
  return lines.join("\n").trim();
}

function formatSearchText(input: {
  query: string;
  totalHits: number;
  results: Array<{
    path: string;
    locale: string;
    title: string;
    description: string;
  }>;
}): string {
  const lines = [`Search: ${input.query}`, `Hits: ${input.totalHits}`];
  if (input.results.length === 0) {
    lines.push("", "No matching pages.");
    return lines.join("\n");
  }

  lines.push("");
  for (const result of input.results) {
    const summary = result.description ? ` - ${result.description}` : "";
    lines.push(`- ${result.locale}/${result.path} :: ${result.title}${summary}`);
  }
  return lines.join("\n");
}

function formatListText(input: {
  path: string;
  locale: string;
  totalPages: number;
  shownPages: number;
  truncated: boolean;
  scanLimitHit: boolean;
  pages: Array<{
    path: string;
    locale: string;
    title: string;
    updatedAt: string;
  }>;
}): string {
  const lines = [
    `List: ${input.locale}/${input.path}`,
    `Pages: ${input.totalPages}`,
  ];

  if (input.pages.length === 0) {
    lines.push("", "No pages found.");
    return lines.join("\n");
  }

  if (input.truncated) {
    lines.push(`Showing: ${input.shownPages}`);
  }

  lines.push("");
  for (const page of input.pages) {
    lines.push(`- ${page.locale}/${page.path} :: ${page.title} (${page.updatedAt})`);
  }

  if (input.scanLimitHit) {
    lines.push("", `Note: Panda scanned only the first ${INTERNAL_LIST_SCAN_LIMIT} wiki pages.`);
  }

  return lines.join("\n");
}

function filterSearchResultsToScope(
  results: WikiPageSearchResult[],
  scopePath: string,
  namespacePath: string,
): WikiPageSearchResult[] {
  const includeArchived = isArchivedWikiPath(scopePath, namespacePath);
  return results.filter((entry) => (
    isWikiPathWithinNamespace(entry.path, scopePath)
    && (includeArchived || !isArchivedWikiPath(entry.path, namespacePath))
  ));
}

function filterListedPagesToScope(
  pages: WikiPageListItem[],
  scopePath: string,
  namespacePath: string,
  includeArchived: boolean,
): WikiPageListItem[] {
  return pages.filter((page) => (
    isWikiPathWithinNamespace(page.path, scopePath)
    && isWikiPathWithinNamespace(page.path, namespacePath)
    && (includeArchived || !isArchivedWikiPath(page.path, namespacePath))
  ));
}

function normalizeListLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIST_LIMIT;
  }

  if (!Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > MAX_LIST_LIMIT) {
    return MAX_LIST_LIMIT;
  }
  return normalized;
}

const wikiPathField = z.string().trim().min(1).describe(
  "Wiki path without locale. It must stay inside the current agent namespace, for example agents/panda/profile. Leading slash is okay; it will be stripped.",
);
const wikiLocaleField = z.string().trim().min(1).describe(
  `Wiki locale. Defaults to ${DEFAULT_WIKI_LOCALE}.`,
);
const wikiLimitField = z.number().int().positive().max(MAX_LIST_LIMIT).describe(
  `Only for list. Maximum pages to return. Defaults to ${DEFAULT_LIST_LIMIT}.`,
);
const wikiIncludeArchivedField = z.boolean().describe(
  "Only for list. Include archived pages under _archive. Defaults to false unless the path itself is inside _archive.",
);
const wikiQueryField = z.string().trim().min(1).describe(
  "Search query for operation=search.",
);
const wikiSectionField = z.string().trim().min(1).describe(
  "Exact markdown heading title to replace or append under a ## section.",
);
const wikiAssetPathField = z.string().trim().min(1).describe(
  "Stored wiki asset path without locale, for example agents/panda/_assets/profile/photo.png.",
);
const wikiSlotField = z.string().trim().min(1).describe(
  "Stable per-page image slot so Panda can replace the same managed image later instead of piling on duplicates.",
);
const wikiSourcePathField = z.string().trim().min(1).describe(
  "Local image file path to upload into Wiki.js.",
);
const wikiAltField = z.string().trim().min(1).describe(
  "Markdown alt text for the inserted image.",
);
const wikiCaptionField = z.string().describe(
  "Optional caption rendered under the image.",
);
const wikiTitleField = z.string().describe(
  "Used when creating a missing page. Optional and ignored on existing-page updates.",
);
const wikiDescriptionField = z.string().describe(
  "Optional page description. When omitted on update, the current description is preserved.",
);
const wikiContentField = z.string().describe(
  "Write replaces the full page body. write_section stores this as the section body under ## <section>.",
);
const wikiTagsField = z.array(z.string().trim().min(1)).describe(
  "Optional tag list. When omitted on update, current tags are preserved.",
);
const wikiIsPublishedField = z.boolean().describe(
  "Optional publish flag. Defaults to true for new pages; preserved on update.",
);
const wikiIsPrivateField = z.boolean().describe(
  "Optional privacy flag. Defaults to false for new pages; preserved on update.",
);
const wikiCreateIfMissingField = z.boolean().describe(
  "Defaults to true when creating pages through write, write_section, or attach_image.",
);
const wikiRewriteLinksField = z.boolean().describe(
  "Only for move. Defaults to true. When enabled, Panda rewrites inbound links from other active pages and adjusts relative links inside the moved page itself.",
);
const wikiBaseUpdatedAtField = z.string().trim().min(1).describe(
  "Optional updatedAt from an earlier read. When provided, write or attach_image aborts on concurrent edits.",
);

function strictSchema<TShape extends z.ZodRawShape>(shape: TShape): z.ZodObject<TShape> {
  return z.object(shape).strict();
}

const wikiGetSchema = strictSchema({
  operation: z.literal("get"),
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
});

const wikiListSchema = strictSchema({
  operation: z.literal("list"),
  path: wikiPathField.optional(),
  locale: wikiLocaleField.optional(),
  limit: wikiLimitField.optional(),
  includeArchived: wikiIncludeArchivedField.optional(),
});

const wikiSearchSchema = strictSchema({
  operation: z.literal("search"),
  path: wikiPathField.optional(),
  locale: wikiLocaleField.optional(),
  query: wikiQueryField,
});

const wikiWriteSchema = strictSchema({
  operation: z.literal("write"),
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  title: wikiTitleField.optional(),
  description: wikiDescriptionField.optional(),
  content: wikiContentField,
  tags: wikiTagsField.optional(),
  isPublished: wikiIsPublishedField.optional(),
  isPrivate: wikiIsPrivateField.optional(),
  createIfMissing: wikiCreateIfMissingField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiWriteSectionSchema = strictSchema({
  operation: z.literal("write_section"),
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  section: wikiSectionField,
  title: wikiTitleField.optional(),
  content: wikiContentField,
  createIfMissing: wikiCreateIfMissingField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiMoveSchema = strictSchema({
  operation: z.literal("move"),
  path: wikiPathField,
  destinationPath: wikiPathField.describe(
    "Destination wiki path without locale. It must stay inside the current agent namespace and outside _archive.",
  ),
  locale: wikiLocaleField.optional(),
  rewriteLinks: wikiRewriteLinksField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiArchiveSchema = strictSchema({
  operation: z.literal("archive"),
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiAttachImageSchema = strictSchema({
  operation: z.literal("attach_image"),
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  section: wikiSectionField,
  slot: wikiSlotField,
  sourcePath: wikiSourcePathField,
  alt: wikiAltField,
  caption: wikiCaptionField.optional(),
  title: wikiTitleField.optional(),
  createIfMissing: wikiCreateIfMissingField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiFetchAssetSchema = strictSchema({
  operation: z.literal("fetch_asset"),
  assetPath: wikiAssetPathField,
});

export class WikiTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WikiTool.schema, TContext> {
  static schema = z.discriminatedUnion("operation", [
    wikiGetSchema,
    wikiListSchema,
    wikiSearchSchema,
    wikiWriteSchema,
    wikiWriteSectionSchema,
    wikiMoveSchema,
    wikiArchiveSchema,
    wikiAttachImageSchema,
    wikiFetchAssetSchema,
  ]).describe(
    "Read, list, search, write, move, archive, attach images, and fetch namespace-scoped assets for agent-owned Wiki.js pages.",
  );

  name = "wiki";
  description = [
    "Read, list, search, write, move, and archive agent-owned Wiki.js pages, plus attach and fetch namespace-scoped assets.",
    "Every path is hard-scoped to the current agent namespace. Do not read or write outside it.",
    "list returns pages under a subtree and hides archived pages unless you explicitly include them.",
    "Write replaces the full page body; there is no line-level patching here.",
    "write_section replaces or appends one ## markdown section so agents do not have to hand-edit whole pages.",
    "attach_image uploads a local image into the page's managed _assets subtree and inserts or replaces one slot-managed markdown image block inside a section.",
    "move is for restructuring live pages and can rewrite inbound links plus relative links inside the moved page.",
    "archive moves a page under the namespace _archive tree instead of deleting it.",
    "fetch_asset downloads one stored asset into Panda media storage so you can inspect it with view_media.",
    "For safe updates, read first and pass baseUpdatedAt back into write or attach_image.",
  ].join("\n");
  schema = WikiTool.schema;

  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;
  private readonly bindings?: Pick<WikiBindingService, "getBinding">;

  constructor(options: WikiToolOptions = {}) {
    super();
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.bindings = options.bindings;
  }

  override formatCall(args: Record<string, unknown>): string {
    const operation = typeof args.operation === "string" ? args.operation : "get";
    if (operation === "move"
      && typeof args.path === "string"
      && typeof args.destinationPath === "string") {
      return `${operation} ${args.path} -> ${args.destinationPath}`;
    }
    if (operation === "write_section"
      && typeof args.path === "string"
      && typeof args.section === "string") {
      return `${operation} ${args.path} :: ${args.section}`;
    }
    if (operation === "attach_image"
      && typeof args.path === "string"
      && typeof args.slot === "string") {
      return `${operation} ${args.path} :: ${args.slot}`;
    }
    if (operation === "fetch_asset" && typeof args.assetPath === "string") {
      return `${operation} ${args.assetPath}`;
    }
    if (typeof args.path === "string") {
      return `${operation} ${args.path}`;
    }
    if (typeof args.query === "string") {
      return `${operation} ${args.query}`;
    }
    return super.formatCall(args);
  }

  private async resolveBinding(agentKey: string): Promise<{
    apiToken: string;
    namespacePath: string;
  }> {
    if (!this.bindings) {
      throw new ToolError("wiki tool is not configured with a binding store.");
    }

    const binding = await this.bindings.getBinding(agentKey);
    if (!binding) {
      throw new ToolError(
        `wiki binding missing for agent ${agentKey}. Run \`panda wiki binding set ${agentKey} ...\`.`,
      );
    }

    return {
      apiToken: binding.apiToken,
      namespacePath: binding.namespacePath,
    };
  }

  private async resolveAssetFolderId(
    client: WikiJsClient,
    folderPath: string,
    assetRoot: string,
    createIfMissing: boolean,
  ): Promise<number | null> {
    if (folderPath === assetRoot) {
      return null;
    }

    const relativePath = folderPath.slice(assetRoot.length + 1);
    const segments = relativePath.split("/").filter(Boolean);
    let parentFolderId: number | null = null;

    for (const rawSegment of segments) {
      const expectedSlug = rawSegment;
      const existingFolders = await client.listAssetFolders(parentFolderId);
      let folder = existingFolders.find((entry) => entry.slug === expectedSlug);
      if (!folder && createIfMissing) {
        await client.createAssetFolder(expectedSlug, parentFolderId);
        const refreshedFolders = await client.listAssetFolders(parentFolderId);
        folder = refreshedFolders.find((entry) => entry.slug === expectedSlug);
      }

      if (!folder) {
        return null;
      }

      parentFolderId = folder.id;
    }

    return parentFolderId;
  }

  private async findAssetByPath(client: WikiJsClient, assetPath: string, assetRoot: string): Promise<{
    id: number;
    filename: string;
  } | null> {
    const {directoryPath, filename} = splitWikiAssetPath(assetPath);
    const folderId = await this.resolveAssetFolderId(client, directoryPath, assetRoot, false);
    if (directoryPath !== assetRoot && folderId === null) {
      return null;
    }

    const assets = await client.listAssets(folderId, "ALL");
    const asset = assets.find((entry) => entry.filename === filename);
    if (!asset) {
      return null;
    }

    return {
      id: asset.id,
      filename: asset.filename,
    };
  }

  private async writePage(
    options: {
      client: WikiJsClient;
      existing: WikiPage | null;
      path: string;
      locale: string;
      content: string;
      createIfMissing: boolean;
      title?: string;
      description?: string;
      tags?: readonly string[];
      isPublished?: boolean;
      isPrivate?: boolean;
      baseUpdatedAt?: string;
      missingTitleMessage: string;
    },
    run: RunContext<TContext>,
  ): Promise<{
    action: "created" | "updated";
    page: WikiPage;
  }> {
    const {
      client,
      existing,
      path,
      locale,
      content,
      createIfMissing,
      title,
      description,
      tags,
      isPublished,
      isPrivate,
      baseUpdatedAt,
      missingTitleMessage,
    } = options;

    if (!existing) {
      if (!createIfMissing) {
        throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
      }
      if (!trimToUndefined(title)) {
        throw new ToolError(missingTitleMessage);
      }

      run.emitToolProgress({status: "creating", path, locale});
      const created = await client.createPage({
        path,
        locale,
        title: title ?? "",
        description: description ?? "",
        content,
        tags: tags ?? [],
        isPublished: isPublished ?? true,
        isPrivate: isPrivate ?? false,
      });
      return {
        action: "created",
        page: created,
      };
    }

    if (baseUpdatedAt) {
      const hasConflict = await client.checkPageConflicts(existing.id, baseUpdatedAt);
      if (hasConflict) {
        const latest = await client.getConflictLatest(existing.id);
        throw new ToolError(
          `Wiki page ${latest.locale}/${latest.path} changed since ${baseUpdatedAt}. Read the latest page before overwriting it.`,
          {
            details: {
              pageId: latest.id,
              path: latest.path,
              locale: latest.locale,
              updatedAt: latest.updatedAt,
              title: latest.title,
            },
          },
        );
      }
    }

    run.emitToolProgress({status: "updating", path, locale});
    const updated = await client.updatePage({
      id: existing.id,
      path,
      locale,
      title: title ?? existing.title,
      description: description ?? existing.description,
      content,
      tags: tags ?? existing.tags,
      isPublished: isPublished ?? existing.isPublished,
      isPrivate: isPrivate ?? existing.isPrivate,
      editor: existing.editor,
    });

    return {
      action: "updated",
      page: updated,
    };
  }

  async handle(
    args: z.output<typeof WikiTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const {agentKey} = readScope(run.context);
    const binding = await this.resolveBinding(agentKey);
    const client = new WikiJsClient({
      apiToken: binding.apiToken,
      baseUrl: resolveWikiUrl(this.env),
      fetchImpl: this.fetchImpl,
    });

    if (args.operation === "fetch_asset") {
      const assetPath = normalizePath(args.assetPath ?? "");
      assertNamespaceAssetPath(assetPath, binding.namespacePath);
      run.emitToolProgress({status: "fetching_asset", assetPath});

      const downloaded = await client.downloadAsset(assetPath);
      const mimeType = inferViewableWikiAssetMimeType(assetPath, downloaded.mimeType);
      if (!mimeType) {
        throw new ToolError(
          `Wiki asset ${assetPath} is not viewable with view_media. Only images and PDFs are supported right now.`,
        );
      }

      const localPath = await writeFetchedWikiAsset(
        assetPath,
        downloaded.bytes,
        run.context as DefaultAgentSessionContext | undefined,
        this.env,
      );

      return buildTextToolPayload(
        `Fetched wiki asset ${assetPath} to ${localPath}. Use view_media on that local path to inspect it.`,
        {
          operation: "fetch_asset",
          assetPath,
          localPath,
          mimeType,
          sizeBytes: downloaded.sizeBytes ?? downloaded.bytes.byteLength,
        },
      );
    }

    if (args.operation === "get") {
      const path = normalizePath(args.path ?? "");
      assertNamespacePath(path, binding.namespacePath);
      const locale = normalizeLocale(args.locale);
      run.emitToolProgress({status: "reading", path, locale});
      const page = await client.getPageByPath(path, locale);
      if (!page) {
        return buildTextToolPayload(
          `No wiki page found at ${locale}/${path}.`,
          {
            operation: "get",
            found: false,
            path,
            locale,
          },
        );
      }

      return buildTextToolPayload(
        formatPageText(page),
        {
          operation: "get",
          found: true,
          ...page,
        } satisfies JsonObject,
      );
    }

    if (args.operation === "search") {
      const locale = normalizeLocale(args.locale);
      const scopePath = args.path ? normalizePath(args.path) : binding.namespacePath;
      assertNamespacePath(scopePath, binding.namespacePath);
      run.emitToolProgress({status: "searching", query: args.query ?? "", locale, path: scopePath});
      // Wiki.js search path filtering behaves like a suffix match, so scope search results here
      // to preserve sane namespace semantics for agents.
      const result = await client.searchPages(args.query ?? "", {locale});
      const scopedResults = filterSearchResultsToScope(
        result.results,
        scopePath,
        binding.namespacePath,
      );
      return buildTextToolPayload(
        formatSearchText({
          query: args.query ?? "",
          totalHits: scopedResults.length,
          results: scopedResults,
        }),
        {
          operation: "search",
          query: args.query ?? "",
          path: scopePath,
          totalHits: scopedResults.length,
          suggestions: result.suggestions,
          results: scopedResults.map((entry) => ({...entry}) satisfies JsonObject),
        },
      );
    }

    if (args.operation === "list") {
      const locale = normalizeLocale(args.locale);
      const scopePath = args.path ? normalizePath(args.path) : binding.namespacePath;
      const limit = normalizeListLimit(args.limit);
      const includeArchived = args.includeArchived === true || isArchivedWikiPath(scopePath, binding.namespacePath);
      assertNamespacePath(scopePath, binding.namespacePath);
      run.emitToolProgress({status: "listing", path: scopePath, locale, limit});

      const listedPages = await client.listPages({
        limit: INTERNAL_LIST_SCAN_LIMIT,
        locale,
        orderBy: "PATH",
        orderByDirection: "ASC",
      });
      const filteredPages = filterListedPagesToScope(
        listedPages,
        scopePath,
        binding.namespacePath,
        includeArchived,
      );
      const pages = filteredPages.slice(0, limit);
      const truncated = filteredPages.length > limit;
      const scanLimitHit = listedPages.length >= INTERNAL_LIST_SCAN_LIMIT;

      return buildTextToolPayload(
        formatListText({
          path: scopePath,
          locale,
          totalPages: filteredPages.length,
          shownPages: pages.length,
          truncated,
          scanLimitHit,
          pages,
        }),
        {
          operation: "list",
          path: scopePath,
          locale,
          count: pages.length,
          totalPages: filteredPages.length,
          truncated,
          scanLimitHit,
          includeArchived,
          pages: pages.map((page) => ({...page}) satisfies JsonObject),
        },
      );
    }

    if (args.operation === "attach_image") {
      const path = normalizePath(args.path ?? "");
      assertNamespacePath(path, binding.namespacePath);
      if (isArchivedWikiPath(path, binding.namespacePath)) {
        throw new ToolError(`Wiki page ${path} is archived. Do not attach images to archive history.`);
      }

      const locale = normalizeLocale(args.locale);
      const createIfMissing = args.createIfMissing ?? true;
      const sectionTitle = normalizeSectionTitle(args.section ?? "");
      const slot = normalizeAssetSlot(args.slot ?? "");
      const alt = normalizeImageText(args.alt ?? "", "alt text");
      const caption = trimToUndefined(args.caption);
      const sourcePath = resolveContextPath(args.sourcePath ?? "", run.context, this.env);
      await assertPathReadable(
        sourcePath,
        (missingPath) => new ToolError(`No readable image file found at ${missingPath}`),
      );

      const imageFile = inferImageFile(sourcePath);
      if (!imageFile) {
        throw new ToolError(
          `attach_image only supports image files that view_media can read. Unsupported file: ${sourcePath}`,
        );
      }

      run.emitToolProgress({status: "loading_page", path, locale});
      const existing = await client.getPageByPath(path, locale);
      if (!existing && !createIfMissing) {
        throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
      }
      if (!existing && !trimToUndefined(args.title)) {
        throw new ToolError("attach_image needs title when creating a new page.");
      }

      const previousAssetPath = existing
        ? findMarkdownImageAssetPath(existing.content, slot)
        : null;
      const bytes = await readFile(sourcePath);
      const assetDirectory = buildWikiPageAssetDirectory(binding.namespacePath, path);
      const assetFilename = buildWikiImageAssetFilename(slot, imageFile.extension);
      const assetPath = `${assetDirectory}/${assetFilename}`;
      assertNamespaceAssetPath(assetPath, binding.namespacePath);

      run.emitToolProgress({status: "ensuring_asset_folder", assetPath});
      const assetRoot = buildWikiAssetRoot(binding.namespacePath);
      const folderId = await this.resolveAssetFolderId(
        client,
        assetDirectory,
        assetRoot,
        true,
      );
      if (folderId === null && assetDirectory !== assetRoot) {
        throw new ToolError(`Wiki.js did not return asset folder ${assetDirectory} after creating it.`);
      }
      run.emitToolProgress({status: "uploading_asset", assetPath});
      await client.uploadAsset({
        folderId,
        filename: assetFilename,
        bytes,
        mimeType: imageFile.mimeType,
      });

      const block = buildMarkdownImageAssetBlock({
        slot,
        assetPath,
        alt,
        ...(caption ? {caption} : {}),
      });
      const sectionContent = existing
        ? upsertMarkdownSectionImageAsset(existing.content, sectionTitle, {
          slot,
          assetPath,
          alt,
          ...(caption ? {caption} : {}),
        })
        : null;
      const nextContent = existing
        ? (sectionContent?.content ?? existing.content)
        : buildMarkdownPageWithSection(args.title ?? "", sectionTitle, block);
      const updatedSection = sectionContent ?? {
        content: nextContent,
        sectionAction: "replaced" as const,
        blockAction: "replaced" as const,
      };

      if (existing && existing.content === nextContent) {
        return buildTextToolPayload(
          `Wiki page ${existing.locale}/${existing.path} already has image slot ${slot} attached.`,
          {
            operation: "attach_image",
            action: "unchanged",
            upload: "uploaded",
            assetPath,
            slot,
            section: {
              title: sectionTitle,
              action: updatedSection.sectionAction,
            },
            block: {
              slot,
              action: updatedSection.blockAction,
            },
            page: {
              id: existing.id,
              path: existing.path,
              locale: existing.locale,
              title: existing.title,
              updatedAt: existing.updatedAt,
            },
          },
        );
      }

      const result = await this.writePage({
        client,
        existing,
        path,
        locale,
        content: nextContent,
        createIfMissing,
        title: existing ? existing.title : args.title,
        description: existing?.description ?? "",
        tags: existing?.tags ?? [],
        isPublished: existing?.isPublished,
        isPrivate: existing?.isPrivate,
        baseUpdatedAt: args.baseUpdatedAt,
        missingTitleMessage: "attach_image needs title when creating a new page.",
      }, run);

      let deletedPreviousAssetPath: string | undefined;
      let staleAssetCleanupError: string | undefined;
      if (previousAssetPath && previousAssetPath !== assetPath) {
        try {
          assertNamespaceAssetPath(previousAssetPath, binding.namespacePath);
          const previousAsset = await this.findAssetByPath(client, previousAssetPath, assetRoot);
          if (previousAsset) {
            await client.deleteAsset(previousAsset.id);
            deletedPreviousAssetPath = previousAssetPath;
          }
        } catch (error) {
          staleAssetCleanupError = error instanceof Error ? error.message : String(error);
        }
      }

      return buildTextToolPayload(
        result.action === "created"
          ? `Created wiki page ${result.page.locale}/${result.page.path} and attached image slot ${slot}.`
          : previousAssetPath && previousAssetPath !== assetPath
            ? `Updated image slot ${slot} in wiki page ${result.page.locale}/${result.page.path}.`
            : `Attached image slot ${slot} to wiki page ${result.page.locale}/${result.page.path}.`,
        {
          operation: "attach_image",
          action: result.action,
          upload: "uploaded",
          assetPath,
          slot,
          ...(deletedPreviousAssetPath ? {deletedPreviousAssetPath} : {}),
          ...(staleAssetCleanupError ? {staleAssetCleanupError} : {}),
          section: {
            title: sectionTitle,
            action: result.action === "created"
              ? "created"
              : updatedSection.sectionAction,
          },
          block: {
            slot,
            action: result.action === "created"
              ? "created"
              : updatedSection.blockAction,
          },
          page: {
            id: result.page.id,
            path: result.page.path,
            locale: result.page.locale,
            title: result.page.title,
            updatedAt: result.page.updatedAt,
          },
        },
      );
    }

    const path = normalizePath(args.path ?? "");
    assertNamespacePath(path, binding.namespacePath);
    const locale = normalizeLocale(args.locale);

    run.emitToolProgress({status: "loading_page", path, locale});
    const existing = await client.getPageByPath(path, locale);

    if (args.operation === "move") {
      if (!existing) {
        throw new ToolError(`Wiki page ${locale}/${path} does not exist.`);
      }

      if (isArchivedWikiPath(path, binding.namespacePath)) {
        throw new ToolError(`Wiki page ${path} is archived. Use archive paths only for history, not live moves.`);
      }

      const destinationPath = normalizePath(args.destinationPath ?? "");
      assertNamespacePath(destinationPath, binding.namespacePath);
      if (isArchivedWikiPath(destinationPath, binding.namespacePath)) {
        throw new ToolError(`Wiki move destination ${destinationPath} is inside _archive. Use archive instead.`);
      }
      if (destinationPath === path) {
        throw new ToolError(`Wiki move destination ${destinationPath} is the same as the current path.`);
      }

      const destinationExisting = await client.getPageByPath(destinationPath, locale);
      if (destinationExisting) {
        throw new ToolError(`Wiki page ${locale}/${destinationPath} already exists.`);
      }

      if (args.baseUpdatedAt) {
        const hasConflict = await client.checkPageConflicts(existing.id, args.baseUpdatedAt);
        if (hasConflict) {
          const latest = await client.getConflictLatest(existing.id);
          throw new ToolError(
            `Wiki page ${latest.locale}/${latest.path} changed since ${args.baseUpdatedAt}. Read the latest page before moving it.`,
            {
              details: {
                pageId: latest.id,
                path: latest.path,
                locale: latest.locale,
                updatedAt: latest.updatedAt,
                title: latest.title,
              },
            },
          );
        }
      }

      run.emitToolProgress({status: "moving", path, locale, destinationPath});
      let moved = await client.movePage({
        id: existing.id,
        destinationPath,
        destinationLocale: locale,
      });

      const rewriteLinks = args.rewriteLinks ?? true;
      const updatedPages: Array<JsonObject> = [];
      const failedPages: Array<JsonObject> = [];
      let rewrittenLinks = 0;

      if (rewriteLinks) {
        const movedRelativeLinks = rewriteRelativeWikiLinksForMovedPage(existing.content, {
          destinationPagePath: moved.path,
          locale,
          sourcePagePath: path,
        });
        const movedRetargetedLinks = retargetWikiLinks(movedRelativeLinks.content, {
          fromPath: path,
          locale,
          sourcePagePath: moved.path,
          toPath: moved.path,
        });
        const movedContent = movedRetargetedLinks.content;
        const movedLinkRewrites = movedRelativeLinks.rewrittenLinks + movedRetargetedLinks.rewrittenLinks;

        if (movedContent !== moved.content) {
          try {
            moved = await client.updatePage({
              id: moved.id,
              path: moved.path,
              locale: moved.locale,
              title: moved.title,
              description: moved.description,
              content: movedContent,
              tags: moved.tags,
              editor: moved.editor,
              isPublished: moved.isPublished,
              isPrivate: moved.isPrivate,
            });
            rewrittenLinks += movedLinkRewrites;
            updatedPages.push({
              path: moved.path,
              locale: moved.locale,
              rewrittenLinks: movedLinkRewrites,
            });
          } catch (error) {
            failedPages.push({
              path: moved.path,
              locale: moved.locale,
              reason: error instanceof Error ? error.message : "unknown error",
            });
          }
        }

        const sourceFullPath = `${locale}/${path}`;
        const linkItems = await client.listPageLinks(locale);
        for (const item of linkItems) {
          if (!item.links.includes(sourceFullPath)) {
            continue;
          }

          const referencingPath = stripWikiLocalePrefix(item.path, locale);
          if (
            referencingPath === moved.path
            || !isWikiPathWithinNamespace(referencingPath, binding.namespacePath)
            || isArchivedWikiPath(referencingPath, binding.namespacePath)
          ) {
            continue;
          }

          const referencingPage = await client.getPageByPath(referencingPath, locale);
          if (!referencingPage) {
            failedPages.push({
              path: referencingPath,
              locale,
              reason: "page disappeared before link rewrite",
            });
            continue;
          }

          const rewritten = retargetWikiLinks(referencingPage.content, {
            fromPath: path,
            locale,
            sourcePagePath: referencingPath,
            toPath: moved.path,
          });
          if (rewritten.rewrittenLinks === 0 || rewritten.content === referencingPage.content) {
            continue;
          }

          try {
            const updated = await client.updatePage({
              id: referencingPage.id,
              path: referencingPage.path,
              locale: referencingPage.locale,
              title: referencingPage.title,
              description: referencingPage.description,
              content: rewritten.content,
              tags: referencingPage.tags,
              editor: referencingPage.editor,
              isPublished: referencingPage.isPublished,
              isPrivate: referencingPage.isPrivate,
            });
            rewrittenLinks += rewritten.rewrittenLinks;
            updatedPages.push({
              path: updated.path,
              locale: updated.locale,
              rewrittenLinks: rewritten.rewrittenLinks,
            });
          } catch (error) {
            failedPages.push({
              path: referencingPath,
              locale,
              reason: error instanceof Error ? error.message : "unknown error",
            });
          }
        }
      }

      const messageParts = [`Moved wiki page ${locale}/${path} to ${moved.locale}/${moved.path}.`];
      if (rewriteLinks) {
        if (rewrittenLinks > 0) {
          messageParts.push(
            `Rewrote ${rewrittenLinks} ${pluralize(rewrittenLinks, "link")} across ${updatedPages.length} ${pluralize(updatedPages.length, "page")}.`,
          );
        } else {
          messageParts.push("No wiki links needed rewriting.");
        }
        if (failedPages.length > 0) {
          messageParts.push(
            `${failedPages.length} ${pluralize(failedPages.length, "page")} could not be rewritten automatically.`,
          );
        }
      }

      return buildTextToolPayload(
        messageParts.join(" "),
        {
          operation: "move",
          movedFrom: path,
          movedTo: moved.path,
          rewriteLinks,
          linkRewrite: {
            rewrittenLinks,
            updatedPages,
            failedPages,
          },
          page: {
            id: moved.id,
            path: moved.path,
            locale: moved.locale,
            title: moved.title,
            updatedAt: moved.updatedAt,
          },
        },
      );
    }

    if (args.operation === "archive") {
      if (!existing) {
        throw new ToolError(`Wiki page ${locale}/${path} does not exist.`);
      }

      if (args.baseUpdatedAt) {
        const hasConflict = await client.checkPageConflicts(existing.id, args.baseUpdatedAt);
        if (hasConflict) {
          const latest = await client.getConflictLatest(existing.id);
          throw new ToolError(
            `Wiki page ${latest.locale}/${latest.path} changed since ${args.baseUpdatedAt}. Read the latest page before archiving it.`,
            {
              details: {
                pageId: latest.id,
                path: latest.path,
                locale: latest.locale,
                updatedAt: latest.updatedAt,
                title: latest.title,
              },
            },
          );
        }
      }

      const archivedPath = buildArchivePath(path, binding.namespacePath);
      run.emitToolProgress({status: "archiving", path, locale, destinationPath: archivedPath});
      const archived = await client.movePage({
        id: existing.id,
        destinationPath: archivedPath,
        destinationLocale: locale,
      });

      return buildTextToolPayload(
        `Archived wiki page ${locale}/${path} to ${archived.locale}/${archived.path}.`,
        {
          operation: "archive",
          archivedFrom: path,
          archivedTo: archived.path,
          page: {
            id: archived.id,
            path: archived.path,
            locale: archived.locale,
            title: archived.title,
            updatedAt: archived.updatedAt,
          },
        },
      );
    }

    if (args.operation === "write_section") {
      const createIfMissing = args.createIfMissing ?? true;
      const sectionTitle = normalizeSectionTitle(args.section ?? "");
      const sectionContent = existing
        ? upsertMarkdownSection(existing.content, sectionTitle, args.content ?? "")
        : (() => {
          if (!createIfMissing) {
            throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
          }
          if (!trimToUndefined(args.title)) {
            throw new ToolError("write_section needs title when creating a new page.");
          }

          return {
            action: "created" as const,
            content: buildMarkdownPageWithSection(args.title ?? "", sectionTitle, args.content ?? ""),
          };
        })();
      const result = await this.writePage({
        client,
        existing,
        path,
        locale,
        content: sectionContent.content,
        createIfMissing,
        title: existing ? existing.title : args.title,
        description: existing?.description ?? "",
        tags: existing?.tags ?? [],
        isPublished: existing?.isPublished,
        isPrivate: existing?.isPrivate,
        baseUpdatedAt: args.baseUpdatedAt,
        missingTitleMessage: "write_section needs title when creating a new page.",
      }, run);

      return buildTextToolPayload(
        result.action === "created"
          ? `Created wiki page ${result.page.locale}/${result.page.path} with section ${sectionTitle}.`
          : sectionContent.action === "appended"
            ? `Added section ${sectionTitle} to wiki page ${result.page.locale}/${result.page.path}.`
            : `Updated section ${sectionTitle} in wiki page ${result.page.locale}/${result.page.path}.`,
        {
          operation: "write_section",
          action: result.action,
          section: {
            title: sectionTitle,
            action: result.action === "created" ? "created" : sectionContent.action,
          },
          page: {
            id: result.page.id,
            path: result.page.path,
            locale: result.page.locale,
            title: result.page.title,
            updatedAt: result.page.updatedAt,
          },
        },
      );
    }

    const createIfMissing = args.createIfMissing ?? true;
    const result = await this.writePage({
      client,
      existing,
      path,
      locale,
      content: args.content ?? "",
      createIfMissing,
      title: args.title,
      description: args.description,
      tags: args.tags,
      isPublished: args.isPublished,
      isPrivate: args.isPrivate,
      baseUpdatedAt: args.baseUpdatedAt,
      missingTitleMessage: "Write needs title when creating a new page.",
    }, run);

    return buildTextToolPayload(
      result.action === "created"
        ? `Created wiki page ${result.page.locale}/${result.page.path}.`
        : `Updated wiki page ${result.page.locale}/${result.page.path}.`,
      {
        operation: "write",
        action: result.action,
        page: {
          id: result.page.id,
          path: result.page.path,
          locale: result.page.locale,
          title: result.page.title,
          updatedAt: result.page.updatedAt,
        },
      },
    );
  }
}
