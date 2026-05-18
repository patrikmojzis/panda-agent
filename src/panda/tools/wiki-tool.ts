import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import type {Tool as PiTool} from "@mariozechner/pi-ai";
import {z} from "zod";

import {resolveContextPath} from "../../app/runtime/panda-path-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {WikiBindingService} from "../../domain/wiki/service.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {formatParameters} from "../../kernel/agent/helpers/schema.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {JsonObject} from "../../lib/json.js";
import {assertPathReadable} from "../../lib/fs.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
  DEFAULT_WIKI_LOCALE,
  resolveWikiUrl,
  type WikiPage,
  type WikiPageListItem,
  type WikiPageSearchResult,
  WikiJsClient,
} from "../../integrations/wiki/client.js";
import {
  buildWikiImageAssetFilename,
  inferViewableWikiAssetMimeType,
  inferWikiImageFile,
  splitWikiAssetPath,
} from "../../integrations/wiki/asset-files.js";
import {
  buildMarkdownImageAssetBlock,
  findMarkdownImageAssetPath,
  upsertMarkdownSectionImageAsset,
} from "../../integrations/wiki/asset-blocks.js";
import {
  buildWikiAssetRoot,
  buildWikiPageAssetDirectory,
  isArchivedWikiPath,
} from "../../integrations/wiki/paths.js";
import {moveWikiPageWithinNamespace} from "../../integrations/wiki/page-move.js";
import {writeWikiPage} from "../../integrations/wiki/page-write.js";
import {
  DEFAULT_WIKI_LIST_LIMIT,
  INTERNAL_WIKI_LIST_SCAN_LIMIT,
  MAX_WIKI_LIST_LIMIT,
  assertWikiNamespaceAssetPath,
  assertWikiNamespacePath,
  buildWikiArchivePath,
  filterWikiListedPagesToScope,
  filterWikiSearchResultsToScope,
  normalizeWikiAssetSlot,
  normalizeWikiImageText,
  normalizeWikiInputLocale,
  normalizeWikiInputPath,
  normalizeWikiListLimit,
  normalizeWikiSectionTitle,
} from "../../integrations/wiki/namespace-policy.js";
import {buildMarkdownPageWithSection, upsertMarkdownSection,} from "../../integrations/wiki/markdown-sections.js";
import {resolveToolArtifactMediaRoot} from "./artifact-paths.js";
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

function pluralizeWikiCount(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function formatWikiPageText(page: WikiPage): string {
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

function formatWikiSearchText(input: {
  query: string;
  totalHits: number;
  results: WikiPageSearchResult[];
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

function formatWikiListText(input: {
  path: string;
  locale: string;
  totalPages: number;
  shownPages: number;
  truncated: boolean;
  scanLimitHit: boolean;
  pages: WikiPageListItem[];
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
    lines.push("", `Note: Panda scanned only the first ${INTERNAL_WIKI_LIST_SCAN_LIMIT} wiki pages.`);
  }

  return lines.join("\n");
}

async function writeFetchedWikiAsset(
  assetPath: string,
  bytes: Uint8Array,
  context: DefaultAgentSessionContext | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const root = path.join(resolveToolArtifactMediaRoot({
    context,
    env,
    source: "wiki",
  }), "wiki", "fetched");
  const destination = path.join(root, ...assetPath.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolError(`Wiki asset path ${assetPath} resolved outside Panda media storage.`);
  }

  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, bytes);
  return destination;
}

const wikiPathField = z.string().trim().min(1).describe(
  "Wiki path without locale. It must stay inside the current agent namespace, for example agents/panda/profile. Leading slash is okay; it will be stripped.",
);
const wikiLocaleField = z.string().trim().min(1).describe(
  `Wiki locale. Defaults to ${DEFAULT_WIKI_LOCALE}.`,
);
const wikiLimitField = z.number().int().positive().max(MAX_WIKI_LIST_LIMIT).describe(
  `Only for list. Maximum pages to return. Defaults to ${DEFAULT_WIKI_LIST_LIMIT}.`,
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

function wikiOperationSchema<TOperation extends string, TShape extends z.ZodRawShape>(
  operation: TOperation,
  shape: TShape,
): z.ZodObject<{operation: z.ZodLiteral<TOperation>} & TShape> {
  return strictSchema({
    operation: z.literal(operation),
    ...shape,
  });
}

const WIKI_OPERATIONS = [
  "read",
  "list",
  "search",
  "write",
  "write_section",
  "move",
  "archive",
  "attach_image",
  "fetch_asset",
] as const;

const WIKI_SCHEMA_DESCRIPTION =
  "Read, list, search, write, move, archive, attach images, and fetch namespace-scoped assets for agent-owned Wiki.js pages.";

const wikiReadSchema = wikiOperationSchema("read", {
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
});

const wikiListSchema = wikiOperationSchema("list", {
  path: wikiPathField.optional(),
  locale: wikiLocaleField.optional(),
  limit: wikiLimitField.optional(),
  includeArchived: wikiIncludeArchivedField.optional(),
});

const wikiSearchSchema = wikiOperationSchema("search", {
  query: wikiQueryField,
  path: wikiPathField.optional(),
  locale: wikiLocaleField.optional(),
});

const wikiWriteSchema = wikiOperationSchema("write", {
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

const wikiWriteSectionSchema = wikiOperationSchema("write_section", {
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  section: wikiSectionField,
  content: wikiContentField,
  title: wikiTitleField.optional(),
  createIfMissing: wikiCreateIfMissingField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiMoveSchema = wikiOperationSchema("move", {
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  destinationPath: wikiPathField.describe(
    "Destination wiki path without locale. It must stay inside the current agent namespace and outside _archive.",
  ),
  rewriteLinks: wikiRewriteLinksField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiArchiveSchema = wikiOperationSchema("archive", {
  path: wikiPathField,
  locale: wikiLocaleField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
});

const wikiAttachImageSchema = wikiOperationSchema("attach_image", {
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

const wikiFetchAssetSchema = wikiOperationSchema("fetch_asset", {
  assetPath: wikiAssetPathField,
});

const wikiOperationSchemas = [
  wikiReadSchema,
  wikiListSchema,
  wikiSearchSchema,
  wikiWriteSchema,
  wikiWriteSectionSchema,
  wikiMoveSchema,
  wikiArchiveSchema,
  wikiAttachImageSchema,
  wikiFetchAssetSchema,
] as const;

const wikiProviderSchema = strictSchema({
  operation: z.enum(WIKI_OPERATIONS).describe(
    "Wiki operation. Required fields by operation: read(path), list(path optional), search(query), write(path+content), write_section(path+section+content), move(path+destinationPath), archive(path), attach_image(path+section+slot+sourcePath+alt), fetch_asset(assetPath).",
  ),
  path: wikiPathField.optional(),
  locale: wikiLocaleField.optional(),
  limit: wikiLimitField.optional(),
  includeArchived: wikiIncludeArchivedField.optional(),
  query: wikiQueryField.optional(),
  section: wikiSectionField.optional(),
  assetPath: wikiAssetPathField.optional(),
  slot: wikiSlotField.optional(),
  sourcePath: wikiSourcePathField.optional(),
  alt: wikiAltField.optional(),
  caption: wikiCaptionField.optional(),
  title: wikiTitleField.optional(),
  description: wikiDescriptionField.optional(),
  content: wikiContentField.optional(),
  tags: wikiTagsField.optional(),
  isPublished: wikiIsPublishedField.optional(),
  isPrivate: wikiIsPrivateField.optional(),
  createIfMissing: wikiCreateIfMissingField.optional(),
  rewriteLinks: wikiRewriteLinksField.optional(),
  baseUpdatedAt: wikiBaseUpdatedAtField.optional(),
  destinationPath: wikiPathField.describe(
    "Only for move. Destination wiki path without locale. It must stay inside the current agent namespace and outside _archive.",
  ).optional(),
}).describe(WIKI_SCHEMA_DESCRIPTION);

export class WikiTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WikiTool.schema, TContext> {
  static schema = z.discriminatedUnion("operation", wikiOperationSchemas).describe(WIKI_SCHEMA_DESCRIPTION);

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

  override get piTool(): PiTool {
    return {
      name: this.name,
      description: this.description,
      parameters: formatParameters(wikiProviderSchema) as PiTool["parameters"],
    };
  }

  override formatCall(args: Record<string, unknown>): string {
    const operation = typeof args.operation === "string" ? args.operation : "read";
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
      const assetPath = normalizeWikiInputPath(args.assetPath);
      assertWikiNamespaceAssetPath(assetPath, binding.namespacePath);
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

    if (args.operation === "read") {
      const path = normalizeWikiInputPath(args.path);
      assertWikiNamespacePath(path, binding.namespacePath);
      const locale = normalizeWikiInputLocale(args.locale);
      run.emitToolProgress({status: "reading", path, locale});
      const page = await client.getPageByPath(path, locale);
      if (!page) {
        return buildTextToolPayload(
          `No wiki page found at ${locale}/${path}.`,
          {
            operation: "read",
            found: false,
            path,
            locale,
          },
        );
      }

      return buildTextToolPayload(
        formatWikiPageText(page),
        {
          operation: "read",
          found: true,
          ...page,
        } satisfies JsonObject,
      );
    }

    if (args.operation === "search") {
      const locale = normalizeWikiInputLocale(args.locale);
      const scopePath = args.path ? normalizeWikiInputPath(args.path) : binding.namespacePath;
      assertWikiNamespacePath(scopePath, binding.namespacePath);
      run.emitToolProgress({status: "searching", query: args.query, locale, path: scopePath});
      // Wiki.js search path filtering behaves like a suffix match, so scope search results here
      // to preserve sane namespace semantics for agents.
      const result = await client.searchPages(args.query, {locale});
      const scopedResults = filterWikiSearchResultsToScope(
        result.results,
        scopePath,
        binding.namespacePath,
      );
      return buildTextToolPayload(
        formatWikiSearchText({
          query: args.query,
          totalHits: scopedResults.length,
          results: scopedResults,
        }),
        {
          operation: "search",
          query: args.query,
          path: scopePath,
          totalHits: scopedResults.length,
          suggestions: result.suggestions,
          results: scopedResults.map((entry) => ({...entry}) satisfies JsonObject),
        },
      );
    }

    if (args.operation === "list") {
      const locale = normalizeWikiInputLocale(args.locale);
      const scopePath = args.path ? normalizeWikiInputPath(args.path) : binding.namespacePath;
      const limit = normalizeWikiListLimit(args.limit);
      const includeArchived = args.includeArchived === true || isArchivedWikiPath(scopePath, binding.namespacePath);
      assertWikiNamespacePath(scopePath, binding.namespacePath);
      run.emitToolProgress({status: "listing", path: scopePath, locale, limit});

      const listedPages = await client.listPages({
        limit: INTERNAL_WIKI_LIST_SCAN_LIMIT,
        locale,
        orderBy: "PATH",
        orderByDirection: "ASC",
      });
      const filteredPages = filterWikiListedPagesToScope(
        listedPages,
        scopePath,
        binding.namespacePath,
        includeArchived,
      );
      const pages = filteredPages.slice(0, limit);
      const truncated = filteredPages.length > limit;
      const scanLimitHit = listedPages.length >= INTERNAL_WIKI_LIST_SCAN_LIMIT;

      return buildTextToolPayload(
        formatWikiListText({
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
      const path = normalizeWikiInputPath(args.path);
      assertWikiNamespacePath(path, binding.namespacePath);
      if (isArchivedWikiPath(path, binding.namespacePath)) {
        throw new ToolError(`Wiki page ${path} is archived. Do not attach images to archive history.`);
      }

      const locale = normalizeWikiInputLocale(args.locale);
      const createIfMissing = args.createIfMissing ?? true;
      const sectionTitle = normalizeWikiSectionTitle(args.section);
      const slot = normalizeWikiAssetSlot(args.slot);
      const alt = normalizeWikiImageText(args.alt, "alt text");
      const caption = trimToUndefined(args.caption);
      const sourcePath = resolveContextPath(args.sourcePath, run.context, this.env);
      await assertPathReadable(
        sourcePath,
        (missingPath) => new ToolError(`No readable image file found at ${missingPath}`),
      );

      const imageFile = inferWikiImageFile(sourcePath);
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
      assertWikiNamespaceAssetPath(assetPath, binding.namespacePath);

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

      const result = await writeWikiPage({
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
        emitProgress: (progress) => run.emitToolProgress(progress),
      });

      let deletedPreviousAssetPath: string | undefined;
      let staleAssetCleanupError: string | undefined;
      if (previousAssetPath && previousAssetPath !== assetPath) {
        try {
          assertWikiNamespaceAssetPath(previousAssetPath, binding.namespacePath);
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

    const path = normalizeWikiInputPath(args.path);
    assertWikiNamespacePath(path, binding.namespacePath);
    const locale = normalizeWikiInputLocale(args.locale);

    run.emitToolProgress({status: "loading_page", path, locale});
    const existing = await client.getPageByPath(path, locale);

    if (args.operation === "move") {
      if (!existing) {
        throw new ToolError(`Wiki page ${locale}/${path} does not exist.`);
      }

      const destinationPath = normalizeWikiInputPath(args.destinationPath);
      assertWikiNamespacePath(destinationPath, binding.namespacePath);
      run.emitToolProgress({status: "moving", path, locale, destinationPath});
      const moveResult = await moveWikiPageWithinNamespace({
        client,
        existing,
        sourcePath: path,
        destinationPath,
        locale,
        namespacePath: binding.namespacePath,
        rewriteLinks: args.rewriteLinks ?? true,
        baseUpdatedAt: args.baseUpdatedAt,
      });
      const {
        page: moved,
        rewriteLinks,
        rewrittenLinks,
        updatedPages,
        failedPages,
      } = moveResult;

      const messageParts = [`Moved wiki page ${locale}/${path} to ${moved.locale}/${moved.path}.`];
      if (rewriteLinks) {
        if (rewrittenLinks > 0) {
          messageParts.push(
            `Rewrote ${rewrittenLinks} ${pluralizeWikiCount(rewrittenLinks, "link")} across ${updatedPages.length} ${pluralizeWikiCount(updatedPages.length, "page")}.`,
          );
        } else {
          messageParts.push("No wiki links needed rewriting.");
        }
        if (failedPages.length > 0) {
          messageParts.push(
            `${failedPages.length} ${pluralizeWikiCount(failedPages.length, "page")} could not be rewritten automatically.`,
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

      const archivedPath = buildWikiArchivePath(path, binding.namespacePath);
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
      const sectionTitle = normalizeWikiSectionTitle(args.section);
      const sectionContent = existing
        ? upsertMarkdownSection(existing.content, sectionTitle, args.content)
        : (() => {
          if (!createIfMissing) {
            throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
          }
          if (!trimToUndefined(args.title)) {
            throw new ToolError("write_section needs title when creating a new page.");
          }

          return {
            action: "created" as const,
            content: buildMarkdownPageWithSection(args.title ?? "", sectionTitle, args.content),
          };
        })();
      const result = await writeWikiPage({
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
        emitProgress: (progress) => run.emitToolProgress(progress),
      });

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
    const result = await writeWikiPage({
      client,
      existing,
      path,
      locale,
      content: args.content,
      createIfMissing,
      title: args.title,
      description: args.description,
      tags: args.tags,
      isPublished: args.isPublished,
      isPrivate: args.isPrivate,
      baseUpdatedAt: args.baseUpdatedAt,
      missingTitleMessage: "Write needs title when creating a new page.",
      emitProgress: (progress) => run.emitToolProgress(progress),
    });

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
