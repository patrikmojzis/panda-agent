import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {
  DEFAULT_WIKI_LOCALE,
  resolveWikiUrl,
  WikiJsClient,
  type WikiPage,
  type WikiPageSearchResult,
} from "../../integrations/wiki/client.js";
import {
  buildWikiArchiveRoot,
  isArchivedWikiPath,
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

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

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

export class WikiTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WikiTool.schema, TContext> {
  static schema = z.object({
    operation: z.enum(["get", "search", "write", "write_section", "move", "archive"]).describe(
      "Read one page, search pages, replace a full page body, replace one markdown section, move a page to a new path, or archive a page by moving it under _archive.",
    ),
    path: z.string().trim().min(1).optional().describe(
      "Wiki path without locale. It must stay inside the current agent namespace, for example agents/panda/profile. Leading slash is okay; it will be stripped. Search defaults to the agent namespace when omitted. Archived pages stay hidden unless you search inside _archive explicitly.",
    ),
    destinationPath: z.string().trim().min(1).optional().describe(
      "Required for move. Destination wiki path without locale. It must stay inside the current agent namespace and outside _archive.",
    ),
    locale: z.string().trim().min(1).optional().describe(
      `Wiki locale. Defaults to ${DEFAULT_WIKI_LOCALE}.`,
    ),
    query: z.string().trim().min(1).optional().describe(
      "Search query for operation=search.",
    ),
    section: z.string().trim().min(1).optional().describe(
      "Required for write_section. Exact markdown heading title to replace or append under a ## section.",
    ),
    title: z.string().optional().describe(
      "Used when creating a missing page. Optional and ignored for write_section updates on existing pages.",
    ),
    description: z.string().optional().describe(
      "Optional page description. When omitted on update, the current description is preserved.",
    ),
    content: z.string().optional().describe(
      "Required for write and write_section. Write replaces the full page body. write_section stores this as the section body under ## <section>.",
    ),
    tags: z.array(z.string().trim().min(1)).optional().describe(
      "Optional tag list. When omitted on update, current tags are preserved.",
    ),
    isPublished: z.boolean().optional().describe(
      "Optional publish flag. Defaults to true for new pages; preserved on update.",
    ),
    isPrivate: z.boolean().optional().describe(
      "Optional privacy flag. Defaults to false for new pages; preserved on update.",
    ),
    createIfMissing: z.boolean().optional().describe(
      "Only for write and write_section. Defaults to true.",
    ),
    rewriteLinks: z.boolean().optional().describe(
      "Only for move. Defaults to true. When enabled, Panda rewrites inbound links from other active pages and adjusts relative links inside the moved page itself.",
    ),
    baseUpdatedAt: z.string().trim().min(1).optional().describe(
      "Optional updatedAt from an earlier read. When provided, write aborts on concurrent edits.",
    ),
  }).superRefine((value, ctx) => {
    if (value.operation === "get") {
      if (value.path === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Get requires path."});
      }
      if (value.query !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Get does not take query."});
      }
      if (value.section !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Get does not take section."});
      }
      if (value.content !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Get does not take content."});
      }
      if (value.destinationPath !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Get does not take destinationPath."});
      }
      if (value.rewriteLinks !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Get does not take rewriteLinks."});
      }
      return;
    }

    if (value.operation === "search") {
      if (value.query === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Search requires query."});
      }
      if (value.content !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Search does not take content."});
      }
      if (value.section !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Search does not take section."});
      }
      if (value.title !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Search does not take title."});
      }
      if (value.destinationPath !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Search does not take destinationPath."});
      }
      if (value.rewriteLinks !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "Search does not take rewriteLinks."});
      }
      return;
    }

    if (value.operation === "write_section") {
      if (value.path === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section requires path."});
      }
      if (value.section === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section requires section."});
      }
      if (value.content === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section requires content."});
      }
      if (value.query !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take query."});
      }
      if (value.description !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take description."});
      }
      if (value.tags !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take tags."});
      }
      if (value.isPublished !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take isPublished."});
      }
      if (value.isPrivate !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take isPrivate."});
      }
      if (value.destinationPath !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take destinationPath."});
      }
      if (value.rewriteLinks !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "write_section does not take rewriteLinks."});
      }
      return;
    }

    if (value.operation === "move") {
      if (value.path === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move requires path."});
      }
      if (value.destinationPath === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move requires destinationPath."});
      }
      if (value.query !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take query."});
      }
      if (value.section !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take section."});
      }
      if (value.title !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take title."});
      }
      if (value.description !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take description."});
      }
      if (value.content !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take content."});
      }
      if (value.tags !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take tags."});
      }
      if (value.isPublished !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take isPublished."});
      }
      if (value.isPrivate !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take isPrivate."});
      }
      if (value.createIfMissing !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "move does not take createIfMissing."});
      }
      return;
    }

    if (value.operation === "archive") {
      if (value.path === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive requires path."});
      }
      if (value.query !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take query."});
      }
      if (value.section !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take section."});
      }
      if (value.title !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take title."});
      }
      if (value.description !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take description."});
      }
      if (value.content !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take content."});
      }
      if (value.tags !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take tags."});
      }
      if (value.isPublished !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take isPublished."});
      }
      if (value.isPrivate !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take isPrivate."});
      }
      if (value.createIfMissing !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take createIfMissing."});
      }
      if (value.destinationPath !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take destinationPath."});
      }
      if (value.rewriteLinks !== undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: "archive does not take rewriteLinks."});
      }
      return;
    }

    if (value.path === undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Write requires path."});
    }
    if (value.section !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Write does not take section."});
    }
    if (value.content === undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Write requires content."});
    }
    if (value.query !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Write does not take query."});
    }
    if (value.destinationPath !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Write does not take destinationPath."});
    }
    if (value.rewriteLinks !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: "Write does not take rewriteLinks."});
    }
  });

  name = "wiki";
  description = [
    "Read, search, write, move, and archive agent-owned Wiki.js pages.",
    "Every path is hard-scoped to the current agent namespace. Do not read or write outside it.",
    "Write replaces the full page body; there is no line-level patching here.",
    "write_section replaces or appends one ## markdown section so agents do not have to hand-edit whole pages.",
    "move is for restructuring live pages and can rewrite inbound links plus relative links inside the moved page.",
    "archive moves a page under the namespace _archive tree instead of deleting it.",
    "For safe updates, read first and pass baseUpdatedAt back into write.",
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

    const path = normalizePath(args.path ?? "");
    assertNamespacePath(path, binding.namespacePath);
    const locale = normalizeLocale(args.locale);
    const createIfMissing = args.createIfMissing ?? true;

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
