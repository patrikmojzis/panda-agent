import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject} from "../../lib/json.js";
import type {WikiJsClient, WikiPage} from "./client.js";
import {assertWikiPageVersionCurrent} from "./page-conflict.js";
import {retargetWikiLinks, rewriteRelativeWikiLinksForMovedPage} from "./link-rewrite.js";
import {
  isArchivedWikiPath,
  isWikiPathWithinNamespace,
  stripWikiLocalePrefix,
} from "./paths.js";

interface WikiMovedPageRewrite extends JsonObject {
  path: string;
  locale: string;
  rewrittenLinks: number;
}

interface WikiMoveFailedPage extends JsonObject {
  path: string;
  locale: string;
  reason: string;
}

interface WikiPageMoveWithinNamespaceResult {
  page: WikiPage;
  rewriteLinks: boolean;
  rewrittenLinks: number;
  updatedPages: WikiMovedPageRewrite[];
  failedPages: WikiMoveFailedPage[];
}

/**
 * Moves one live namespace page and optionally rewrites internal links affected
 * by that move.
 */
export async function moveWikiPageWithinNamespace(input: {
  client: WikiJsClient;
  existing: WikiPage;
  sourcePath: string;
  destinationPath: string;
  locale: string;
  namespacePath: string;
  rewriteLinks: boolean;
  baseUpdatedAt?: string;
}): Promise<WikiPageMoveWithinNamespaceResult> {
  const {
    client,
    existing,
    sourcePath,
    destinationPath,
    locale,
    namespacePath,
    rewriteLinks,
    baseUpdatedAt,
  } = input;

  if (isArchivedWikiPath(sourcePath, namespacePath)) {
    throw new ToolError(`Wiki page ${sourcePath} is archived. Use archive paths only for history, not live moves.`);
  }
  if (isArchivedWikiPath(destinationPath, namespacePath)) {
    throw new ToolError(`Wiki move destination ${destinationPath} is inside _archive. Use archive instead.`);
  }
  if (destinationPath === sourcePath) {
    throw new ToolError(`Wiki move destination ${destinationPath} is the same as the current path.`);
  }

  await assertWikiPageVersionCurrent({
    client,
    page: existing,
    baseUpdatedAt,
    namespacePath,
    requestedPath: sourcePath,
  });

  const destinationExisting = await client.getPageByPath(destinationPath, locale);
  if (destinationExisting) {
    throw new ToolError(`Wiki page ${locale}/${destinationPath} already exists.`);
  }

  let moved = await client.movePage({
    id: existing.id,
    destinationPath,
    destinationLocale: locale,
  });

  const updatedPages: WikiMovedPageRewrite[] = [];
  const failedPages: WikiMoveFailedPage[] = [];
  let rewrittenLinks = 0;

  if (!rewriteLinks) {
    return {
      page: moved,
      rewriteLinks,
      rewrittenLinks,
      updatedPages,
      failedPages,
    };
  }

  const movedRelativeLinks = rewriteRelativeWikiLinksForMovedPage(existing.content, {
    destinationPagePath: moved.path,
    locale,
    sourcePagePath: sourcePath,
  });
  const movedRetargetedLinks = retargetWikiLinks(movedRelativeLinks.content, {
    fromPath: sourcePath,
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

  const sourceFullPath = `${locale}/${sourcePath}`;
  const linkItems = await client.listPageLinks(locale);
  for (const item of linkItems) {
    if (!item.links.includes(sourceFullPath)) {
      continue;
    }

    const referencingPath = stripWikiLocalePrefix(item.path, locale);
    if (
      referencingPath === moved.path
      || !isWikiPathWithinNamespace(referencingPath, namespacePath)
      || isArchivedWikiPath(referencingPath, namespacePath)
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
      fromPath: sourcePath,
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

  return {
    page: moved,
    rewriteLinks,
    rewrittenLinks,
    updatedPages,
    failedPages,
  };
}
