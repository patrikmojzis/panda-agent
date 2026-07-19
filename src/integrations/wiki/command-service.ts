import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import type {WikiBindingService} from "../../domain/wiki/service.js";
import type {
  WikiArchiveCommandInput,
  WikiAttachImageResolvedCommandInput,
  WikiCommandService,
  WikiDeleteAssetCommandInput,
  WikiDiffCommandInput,
  WikiFetchAssetCommandInput,
  WikiFetchAssetCommandResult,
  WikiListCommandInput,
  WikiMoveCommandInput,
  WikiOverviewCommandInput,
  WikiReadCommandInput,
  WikiRestoreCommandInput,
  WikiSearchCommandInput,
  WikiWriteCommandInput,
  WikiWriteSectionCommandInput,
} from "../../domain/wiki/commands.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {resolveAgentMediaDir} from "../../lib/data-dir.js";
import type {JsonObject} from "../../lib/json.js";
import {requireJsonValue} from "../../lib/json.js";
import {readSafePathSegment} from "../../lib/path-segments.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
  DEFAULT_WIKI_LOCALE,
  resolveWikiUrl,
  type WikiPage,
  WikiJsClient,
} from "./client.js";
import {
  buildWikiImageAssetFilename,
  inferViewableWikiAssetMimeType,
  inferWikiImageFile,
  splitWikiAssetPath,
} from "./asset-files.js";
import {
  buildMarkdownImageAssetBlock,
  findMarkdownImageAssetPath,
  upsertMarkdownSectionImageAsset,
} from "./asset-blocks.js";
import {buildMarkdownPageWithSection, upsertMarkdownSection} from "./markdown-sections.js";
import {moveWikiPageWithinNamespace} from "./page-move.js";
import {assertWikiPageVersionCurrent} from "./page-conflict.js";
import {writeWikiPage} from "./page-write.js";
import {
  buildWikiArchivePath,
  DEFAULT_WIKI_LIST_LIMIT,
  INTERNAL_WIKI_LIST_SCAN_LIMIT,
  assertWikiNamespaceAssetPath,
  filterWikiListedPagesToScope,
  filterWikiSearchResultsToScope,
  normalizeWikiAssetSlot,
  normalizeWikiImageText,
  normalizeWikiInputLocale,
  normalizeWikiListLimit,
  normalizeWikiSectionTitle,
  resolveWikiInputPath,
} from "./namespace-policy.js";
import {buildWikiAssetRoot, buildWikiPageAssetDirectory, isArchivedWikiPath} from "./paths.js";
import {buildWikiContentDiff} from "./content-diff.js";
import {WikiOverviewReader} from "./overview.js";

export interface WikiCommandServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  bindings: Pick<WikiBindingService, "getBinding">;
}

function wikiPageSummary(page: WikiPage): JsonObject {
  return {
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title,
    updatedAt: page.updatedAt,
  };
}

function wikiDiffPageSummary(page: WikiPage): JsonObject {
  return {
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title,
    updatedAt: page.updatedAt,
    contentLines: page.content.length === 0 ? 0 : page.content.split(/\r?\n/).length,
  };
}

function resolveWikiFetchedAssetRoot(agentKey: string, env: NodeJS.ProcessEnv): string {
  const safeAgentKey = readSafePathSegment(agentKey);
  if (!safeAgentKey) {
    throw new ToolError(`Unsafe agent key for wiki artifact path: ${agentKey}`);
  }

  return path.join(resolveAgentMediaDir(safeAgentKey, env), "wiki", "fetched");
}

async function writeFetchedWikiAsset(params: {
  agentKey: string;
  assetPath: string;
  bytes: Uint8Array;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const root = resolveWikiFetchedAssetRoot(params.agentKey, params.env);
  const destination = path.join(root, ...params.assetPath.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolError(`Wiki asset path ${params.assetPath} resolved outside Panda media storage.`);
  }

  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, params.bytes);
  return destination;
}

export class WikiRuntimeCommandService implements WikiCommandService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;
  private readonly bindings: Pick<WikiBindingService, "getBinding">;
  private readonly overviewReader: WikiOverviewReader;

  constructor(options: WikiCommandServiceOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.bindings = options.bindings;
    this.overviewReader = new WikiOverviewReader(options);
  }

  private async resolveClient(agentKey: string): Promise<{
    client: WikiJsClient;
    namespacePath: string;
  }> {
    const binding = await this.bindings.getBinding(agentKey);
    if (!binding) {
      throw new ToolError(
        `wiki binding missing for agent ${agentKey}. Run \`panda wiki binding set ${agentKey} ...\`.`,
      );
    }

    return {
      namespacePath: binding.namespacePath,
      client: new WikiJsClient({
        apiToken: binding.apiToken,
        baseUrl: resolveWikiUrl(this.env),
        fetchImpl: this.fetchImpl,
      }),
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

  async overviewPages(agentKey: string, input: WikiOverviewCommandInput): Promise<JsonObject> {
    const snapshot = await this.overviewReader.read({
      agentKey,
      locale: input.locale,
    });
    if (!snapshot) {
      throw new ToolError(
        `wiki binding missing for agent ${agentKey}. Run \`panda wiki binding set ${agentKey} ...\`.`,
      );
    }

    return {
      operation: "overview",
      namespacePath: snapshot.namespacePath,
      locale: snapshot.locale,
      recentlyEdited: snapshot.recentlyEdited.map((entry) => requireJsonValue(entry, "wiki.overview recent page")),
      mostLinked: snapshot.topLinked.map((entry) => requireJsonValue(entry, "wiki.overview linked page")),
    };
  }

  async readPage(agentKey: string, input: WikiReadCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: path} = resolveWikiInputPath(input.path, namespacePath, "page");
    const locale = normalizeWikiInputLocale(input.locale);
    const page = await client.getPageByPath(path, locale);
    if (!page) {
      return {
        operation: "read",
        found: false,
        path,
        locale,
        namespacePath,
        inputPath,
        resolvedPath: path,
      };
    }

    return {
      operation: "read",
      found: true,
      ...requireJsonValue(page, "wiki.read page") as JsonObject,
      namespacePath,
      inputPath,
      resolvedPath: path,
    };
  }

  async searchPages(agentKey: string, input: WikiSearchCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const locale = normalizeWikiInputLocale(input.locale);
    const resolution = input.path
      ? resolveWikiInputPath(input.path, namespacePath, "page")
      : undefined;
    const scopePath = resolution?.resolvedPath ?? namespacePath;
    const result = await client.searchPages(input.query, {locale});
    const scopedResults = filterWikiSearchResultsToScope(
      result.results,
      scopePath,
      namespacePath,
    );
    const limit = input.limit === undefined ? undefined : normalizeWikiListLimit(input.limit);
    const results = limit === undefined ? scopedResults : scopedResults.slice(0, limit);

    return {
      operation: "search",
      query: input.query,
      path: scopePath,
      namespacePath,
      ...(resolution ? {inputPath: resolution.inputPath} : {}),
      resolvedPath: scopePath,
      totalHits: scopedResults.length,
      count: results.length,
      truncated: results.length < scopedResults.length,
      suggestions: result.suggestions,
      results: results.map((entry) => requireJsonValue(entry, "wiki.search result")),
    };
  }

  async listPages(agentKey: string, input: WikiListCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const locale = normalizeWikiInputLocale(input.locale ?? DEFAULT_WIKI_LOCALE);
    const resolution = input.path
      ? resolveWikiInputPath(input.path, namespacePath, "page")
      : undefined;
    const scopePath = resolution?.resolvedPath ?? namespacePath;
    const limit = normalizeWikiListLimit(input.limit ?? DEFAULT_WIKI_LIST_LIMIT);
    const includeArchived = input.includeArchived === true || isArchivedWikiPath(scopePath, namespacePath);

    const listedPages = await client.listPages({
      limit: INTERNAL_WIKI_LIST_SCAN_LIMIT,
      locale,
      orderBy: "PATH",
      orderByDirection: "ASC",
    });
    const filteredPages = filterWikiListedPagesToScope(
      listedPages,
      scopePath,
      namespacePath,
      includeArchived,
    );
    const pages = filteredPages.slice(0, limit);

    return {
      operation: "list",
      path: scopePath,
      namespacePath,
      ...(resolution ? {inputPath: resolution.inputPath} : {}),
      resolvedPath: scopePath,
      locale,
      count: pages.length,
      totalPages: filteredPages.length,
      truncated: filteredPages.length > limit,
      scanLimitHit: listedPages.length >= INTERNAL_WIKI_LIST_SCAN_LIMIT,
      includeArchived,
      pages: pages.map((page) => requireJsonValue(page, "wiki.list page")),
    };
  }

  async diffPages(agentKey: string, input: WikiDiffCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const locale = normalizeWikiInputLocale(input.locale ?? DEFAULT_WIKI_LOCALE);
    const left = resolveWikiInputPath(input.leftPath, namespacePath, "page");
    const right = resolveWikiInputPath(input.rightPath, namespacePath, "page");
    const leftPath = left.resolvedPath;
    const rightPath = right.resolvedPath;

    const [leftPage, rightPage] = await Promise.all([
      client.getPageByPath(leftPath, locale),
      client.getPageByPath(rightPath, locale),
    ]);
    if (!leftPage) {
      throw new ToolError(`Wiki page ${locale}/${leftPath} does not exist.`);
    }
    if (!rightPage) {
      throw new ToolError(`Wiki page ${locale}/${rightPath} does not exist.`);
    }

    const contextLines = Math.min(input.contextLines ?? 3, 20);
    const diff = buildWikiContentDiff(leftPage.content, rightPage.content, {
      contextLines,
    });

    return {
      operation: "diff",
      locale,
      namespacePath,
      leftInputPath: left.inputPath,
      leftResolvedPath: leftPath,
      rightInputPath: right.inputPath,
      rightResolvedPath: rightPath,
      left: wikiDiffPageSummary(leftPage),
      right: wikiDiffPageSummary(rightPage),
      equal: diff.equal,
      stats: requireJsonValue(diff.stats, "wiki.diff stats"),
      hunks: requireJsonValue(diff.hunks, "wiki.diff hunks"),
      truncated: diff.truncated,
      contextLines,
    };
  }

  async writePage(agentKey: string, input: WikiWriteCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: path} = resolveWikiInputPath(input.path, namespacePath, "page");
    const locale = normalizeWikiInputLocale(input.locale);
    const existing = await client.getPageByPath(path, locale);
    const result = await writeWikiPage({
      client,
      existing,
      path,
      locale,
      namespacePath,
      content: input.content,
      createIfMissing: input.createIfMissing ?? true,
      title: input.title,
      description: input.description,
      tags: input.tags,
      isPublished: input.isPublished,
      isPrivate: input.isPrivate,
      baseUpdatedAt: input.baseUpdatedAt,
      missingTitleMessage: "Write needs title when creating a new page.",
    });

    return {
      operation: "write",
      action: result.action,
      namespacePath,
      inputPath,
      resolvedPath: path,
      page: wikiPageSummary(result.page),
    };
  }

  async writeSection(agentKey: string, input: WikiWriteSectionCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: path} = resolveWikiInputPath(input.path, namespacePath, "page");
    const locale = normalizeWikiInputLocale(input.locale);
    const existing = await client.getPageByPath(path, locale);
    const createIfMissing = input.createIfMissing ?? true;
    const sectionTitle = normalizeWikiSectionTitle(input.section);
    const sectionContent = existing
      ? upsertMarkdownSection(existing.content, sectionTitle, input.content)
      : (() => {
        if (!createIfMissing) {
          throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
        }
        if (!trimToUndefined(input.title)) {
          throw new ToolError("write_section needs title when creating a new page.");
        }

        return {
          action: "created" as const,
          content: buildMarkdownPageWithSection(input.title ?? "", sectionTitle, input.content),
        };
      })();
    const result = await writeWikiPage({
      client,
      existing,
      path,
      locale,
      namespacePath,
      content: sectionContent.content,
      createIfMissing,
      title: existing ? existing.title : input.title,
      description: existing?.description ?? "",
      tags: existing?.tags ?? [],
      isPublished: existing?.isPublished,
      isPrivate: existing?.isPrivate,
      baseUpdatedAt: input.baseUpdatedAt,
      missingTitleMessage: "write_section needs title when creating a new page.",
    });

    return {
      operation: "write_section",
      action: result.action,
      namespacePath,
      inputPath,
      resolvedPath: path,
      section: {
        title: sectionTitle,
        action: result.action === "created" ? "created" : sectionContent.action,
      },
      page: wikiPageSummary(result.page),
    };
  }

  async movePage(agentKey: string, input: WikiMoveCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const source = resolveWikiInputPath(input.path, namespacePath, "page");
    const destination = resolveWikiInputPath(input.destinationPath, namespacePath, "page");
    const path = source.resolvedPath;
    const destinationPath = destination.resolvedPath;
    const locale = normalizeWikiInputLocale(input.locale);
    const existing = await client.getPageByPath(path, locale);
    if (!existing) {
      throw new ToolError(`Wiki page ${locale}/${path} does not exist.`);
    }

    const moveResult = await moveWikiPageWithinNamespace({
      client,
      existing,
      sourcePath: path,
      destinationPath,
      locale,
      namespacePath,
      rewriteLinks: input.rewriteLinks ?? true,
      baseUpdatedAt: input.baseUpdatedAt,
    });
    const {
      page: moved,
      rewriteLinks,
      rewrittenLinks,
      updatedPages,
      failedPages,
    } = moveResult;

    return {
      operation: "move",
      namespacePath,
      inputPath: source.inputPath,
      resolvedPath: path,
      destinationInputPath: destination.inputPath,
      destinationResolvedPath: destinationPath,
      movedFrom: path,
      movedTo: moved.path,
      rewriteLinks,
      linkRewrite: {
        rewrittenLinks,
        updatedPages: requireJsonValue(updatedPages, "wiki.move updatedPages"),
        failedPages: requireJsonValue(failedPages, "wiki.move failedPages"),
      },
      page: wikiPageSummary(moved),
    };
  }

  async archivePage(agentKey: string, input: WikiArchiveCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: path} = resolveWikiInputPath(input.path, namespacePath, "page");
    const locale = normalizeWikiInputLocale(input.locale);
    const existing = await client.getPageByPath(path, locale);
    if (!existing) {
      throw new ToolError(`Wiki page ${locale}/${path} does not exist.`);
    }

    await assertWikiPageVersionCurrent({
      client,
      page: existing,
      baseUpdatedAt: input.baseUpdatedAt,
      namespacePath,
      requestedPath: path,
    });

    const archivedPath = buildWikiArchivePath(path, namespacePath);
    const archived = await client.movePage({
      id: existing.id,
      destinationPath: archivedPath,
      destinationLocale: locale,
    });

    return {
      operation: "archive",
      namespacePath,
      inputPath,
      resolvedPath: path,
      archivedFrom: path,
      archivedTo: archived.path,
      page: wikiPageSummary(archived),
    };
  }

  async restorePage(agentKey: string, input: WikiRestoreCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const archived = resolveWikiInputPath(input.path, namespacePath, "page");
    const destination = resolveWikiInputPath(input.destinationPath, namespacePath, "page");
    const path = archived.resolvedPath;
    const destinationPath = destination.resolvedPath;
    if (!isArchivedWikiPath(path, namespacePath)) {
      throw new ToolError(`Wiki page ${path} is not archived. Use wiki.move for live page moves.`);
    }

    const locale = normalizeWikiInputLocale(input.locale);
    const existing = await client.getPageByPath(path, locale);
    if (!existing) {
      throw new ToolError(`Wiki page ${locale}/${path} does not exist.`);
    }

    await assertWikiPageVersionCurrent({
      client,
      page: existing,
      baseUpdatedAt: input.baseUpdatedAt,
      namespacePath,
      requestedPath: path,
    });

    if (isArchivedWikiPath(destinationPath, namespacePath)) {
      throw new ToolError("Wiki restore destination must be a live namespace path, not _archive.");
    }

    const target = await client.getPageByPath(destinationPath, locale);
    if (target) {
      throw new ToolError(`Wiki page ${locale}/${destinationPath} already exists. Pick an empty restore destination.`);
    }

    const restored = await client.movePage({
      id: existing.id,
      destinationPath,
      destinationLocale: locale,
    });

    return {
      operation: "restore",
      namespacePath,
      inputPath: archived.inputPath,
      resolvedPath: path,
      destinationInputPath: destination.inputPath,
      destinationResolvedPath: destinationPath,
      restoredFrom: path,
      restoredTo: restored.path,
      page: wikiPageSummary(restored),
    };
  }

  async attachImage(agentKey: string, input: WikiAttachImageResolvedCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: path} = resolveWikiInputPath(input.path, namespacePath, "page");
    if (isArchivedWikiPath(path, namespacePath)) {
      throw new ToolError(`Wiki page ${path} is archived. Do not attach images to archive history.`);
    }

    const locale = normalizeWikiInputLocale(input.locale);
    const createIfMissing = input.createIfMissing ?? true;
    const sectionTitle = normalizeWikiSectionTitle(input.section);
    const slot = normalizeWikiAssetSlot(input.slot);
    const alt = normalizeWikiImageText(input.alt, "alt text");
    const caption = trimToUndefined(input.caption);
    const imageFile = inferWikiImageFile(input.resolvedSourcePath);
    if (!imageFile) {
      throw new ToolError(
        `attach_image only supports image files that view_media can read. Unsupported file: ${input.sourcePath}`,
      );
    }

    const existing = await client.getPageByPath(path, locale);
    if (!existing && !createIfMissing) {
      throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
    }
    if (!existing && !trimToUndefined(input.title)) {
      throw new ToolError("attach_image needs title when creating a new page.");
    }
    if (existing) {
      await assertWikiPageVersionCurrent({
        client,
        page: existing,
        baseUpdatedAt: input.baseUpdatedAt,
        namespacePath,
        requestedPath: path,
      });
    }

    const previousAssetPath = existing
      ? findMarkdownImageAssetPath(existing.content, slot)
      : null;
    const bytes = await readFile(input.resolvedSourcePath);
    const assetDirectory = buildWikiPageAssetDirectory(namespacePath, path);
    const assetFilename = buildWikiImageAssetFilename(slot, imageFile.extension);
    const assetPath = `${assetDirectory}/${assetFilename}`;
    assertWikiNamespaceAssetPath(assetPath, namespacePath);

    const assetRoot = buildWikiAssetRoot(namespacePath);
    const folderId = await this.resolveAssetFolderId(
      client,
      assetDirectory,
      assetRoot,
      true,
    );
    if (folderId === null && assetDirectory !== assetRoot) {
      throw new ToolError(`Wiki.js did not return asset folder ${assetDirectory} after creating it.`);
    }
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
      : buildMarkdownPageWithSection(input.title ?? "", sectionTitle, block);
    const updatedSection = sectionContent ?? {
      content: nextContent,
      sectionAction: "replaced" as const,
      blockAction: "replaced" as const,
    };

    if (existing && existing.content === nextContent) {
      return {
        operation: "attach_image",
        action: "unchanged",
        namespacePath,
        inputPath,
        resolvedPath: path,
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
        page: wikiPageSummary(existing),
      };
    }

    const result = await writeWikiPage({
      client,
      existing,
      path,
      locale,
      namespacePath,
      content: nextContent,
      createIfMissing,
      title: existing ? existing.title : input.title,
      description: existing?.description ?? "",
      tags: existing?.tags ?? [],
      isPublished: existing?.isPublished,
      isPrivate: existing?.isPrivate,
      baseUpdatedAt: input.baseUpdatedAt,
      missingTitleMessage: "attach_image needs title when creating a new page.",
    });

    let deletedPreviousAssetPath: string | undefined;
    let staleAssetCleanupError: string | undefined;
    if (previousAssetPath && previousAssetPath !== assetPath) {
      try {
        assertWikiNamespaceAssetPath(previousAssetPath, namespacePath);
        const previousAsset = await this.findAssetByPath(client, previousAssetPath, assetRoot);
        if (previousAsset) {
          await client.deleteAsset(previousAsset.id);
          deletedPreviousAssetPath = previousAssetPath;
        }
      } catch (error) {
        staleAssetCleanupError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      operation: "attach_image",
      action: result.action,
      namespacePath,
      inputPath,
      resolvedPath: path,
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
      page: wikiPageSummary(result.page),
    };
  }

  async fetchAsset(agentKey: string, input: WikiFetchAssetCommandInput): Promise<WikiFetchAssetCommandResult> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: assetPath} = resolveWikiInputPath(input.assetPath, namespacePath, "asset");

    const downloaded = await client.downloadAsset(assetPath);
    const mimeType = inferViewableWikiAssetMimeType(assetPath, downloaded.mimeType);
    if (!mimeType) {
      throw new ToolError(
        `Wiki asset ${assetPath} is not viewable with view_media. Only images and PDFs are supported right now.`,
      );
    }

    const localPath = await writeFetchedWikiAsset({
      agentKey,
      assetPath,
      bytes: downloaded.bytes,
      env: this.env,
    });
    const sizeBytes = downloaded.sizeBytes ?? downloaded.bytes.byteLength;
    const artifact = {
      kind: mimeType === "application/pdf" ? "pdf" as const : "image" as const,
      source: "view_media" as const,
      path: localPath,
      mimeType,
      bytes: sizeBytes,
      originalPath: assetPath,
    };

    return {
      output: {
        operation: "fetch_asset",
        namespacePath,
        inputPath,
        resolvedPath: assetPath,
        assetPath,
        localPath,
        mimeType,
        sizeBytes,
      },
      artifact,
    };
  }

  async deleteAsset(agentKey: string, input: WikiDeleteAssetCommandInput): Promise<JsonObject> {
    const {client, namespacePath} = await this.resolveClient(agentKey);
    const {inputPath, resolvedPath: assetPath} = resolveWikiInputPath(input.assetPath, namespacePath, "asset");
    const assetRoot = buildWikiAssetRoot(namespacePath);
    const asset = await this.findAssetByPath(client, assetPath, assetRoot);
    if (!asset) {
      throw new ToolError(`Wiki asset ${assetPath} does not exist.`);
    }

    await client.deleteAsset(asset.id);

    return {
      operation: "delete_asset",
      namespacePath,
      inputPath,
      resolvedPath: assetPath,
      assetPath,
      assetId: asset.id,
      filename: asset.filename,
      deleted: true,
    };
  }
}
