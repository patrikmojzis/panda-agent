import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {WikiJsClient, WikiPage} from "./client.js";

interface WikiPageWriteProgress extends JsonObject {
  status: "creating" | "updating";
  path: string;
  locale: string;
}

interface WikiPageWriteResult {
  action: "created" | "updated";
  page: WikiPage;
}

/**
 * Creates or updates one Wiki.js page with optional optimistic conflict checks.
 */
export async function writeWikiPage(input: {
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
  emitProgress?: (progress: WikiPageWriteProgress) => void;
}): Promise<WikiPageWriteResult> {
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
    emitProgress,
  } = input;

  if (!existing) {
    if (!createIfMissing) {
      throw new ToolError(`Wiki page ${locale}/${path} does not exist and createIfMissing=false.`);
    }
    if (!trimToUndefined(title)) {
      throw new ToolError(missingTitleMessage);
    }

    emitProgress?.({status: "creating", path, locale});
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

  emitProgress?.({status: "updating", path, locale});
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
