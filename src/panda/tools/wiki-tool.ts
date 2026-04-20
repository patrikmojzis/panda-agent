import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {
  DEFAULT_WIKI_LOCALE,
  resolveWikiUrl,
  WikiJsClient,
  type WikiPage,
  type WikiPageSearchResult,
} from "../../integrations/wiki/client.js";
import {buildMarkdownPageWithSection, upsertMarkdownSection,} from "../../integrations/wiki/markdown-sections.js";

export interface WikiToolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  bindings?: Pick<WikiBindingService, "getBinding">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScope(context: unknown): {agentKey: string} {
  if (!isRecord(context) || typeof context.agentKey !== "string" || !context.agentKey.trim()) {
    throw new ToolError("wiki requires agentKey in the current runtime session context.");
  }

  return {
    agentKey: context.agentKey.trim(),
  };
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new ToolError("wiki path must not be empty.");
  }
  return trimmed;
}

function normalizeLocale(value: string | undefined): string {
  return trimNonEmpty(value) ?? DEFAULT_WIKI_LOCALE;
}

function normalizeSectionTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError("wiki section must not be empty.");
  }

  return trimmed;
}

function isPathWithinNamespace(path: string, namespacePath: string): boolean {
  return path === namespacePath || path.startsWith(`${namespacePath}/`);
}

function buildArchiveRoot(namespacePath: string): string {
  return `${namespacePath}/_archive`;
}

function isArchivedPath(path: string, namespacePath: string): boolean {
  const archiveRoot = buildArchiveRoot(namespacePath);
  return path === archiveRoot || path.startsWith(`${archiveRoot}/`);
}

function buildArchivePath(path: string, namespacePath: string, now = new Date()): string {
  if (isArchivedPath(path, namespacePath)) {
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

  return `${buildArchiveRoot(namespacePath)}/${year}/${month}/${safeLeaf}-${timestamp}`;
}

function assertNamespacePath(path: string, namespacePath: string): void {
  if (!isPathWithinNamespace(path, namespacePath)) {
    throw new ToolError(
      `Wiki path ${path} is outside the agent namespace ${namespacePath}.`,
    );
  }
}

function buildPayload(details: JsonObject, text: string): ToolResultPayload {
  return {
    content: [{
      type: "text",
      text,
    }],
    details,
  };
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
  const includeArchived = isArchivedPath(scopePath, namespacePath);
  return results.filter((entry) => (
    isPathWithinNamespace(entry.path, scopePath)
    && (includeArchived || !isArchivedPath(entry.path, namespacePath))
  ));
}

export class WikiTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WikiTool.schema, TContext> {
  static schema = z.object({
    operation: z.enum(["get", "search", "write", "write_section", "archive"]).describe(
      "Read one page, search pages, replace a full page body, replace one markdown section, or archive a page by moving it under _archive.",
    ),
    path: z.string().trim().min(1).optional().describe(
      "Wiki path without locale, for example agents/panda/profile. Leading slash is okay; it will be stripped. Search defaults to the agent namespace when omitted. Archived pages stay hidden unless you search inside _archive explicitly.",
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
  });

  name = "wiki";
  description = [
    "Read, search, write, and archive agent-owned Wiki.js pages.",
    "Write replaces the full page body; there is no line-level patching here.",
    "write_section replaces or appends one ## markdown section so agents do not have to hand-edit whole pages.",
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
      if (!trimNonEmpty(title)) {
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
        return buildPayload(
          {
            operation: "get",
            found: false,
            path,
            locale,
          },
          `No wiki page found at ${locale}/${path}.`,
        );
      }

      return buildPayload(
        {
          operation: "get",
          found: true,
          ...page,
        } satisfies JsonObject,
        formatPageText(page),
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
      return buildPayload(
        {
          operation: "search",
          query: args.query ?? "",
          path: scopePath,
          totalHits: scopedResults.length,
          suggestions: result.suggestions,
          results: scopedResults.map((entry) => ({...entry}) satisfies JsonObject),
        },
        formatSearchText({
          query: args.query ?? "",
          totalHits: scopedResults.length,
          results: scopedResults,
        }),
      );
    }

    const path = normalizePath(args.path ?? "");
    assertNamespacePath(path, binding.namespacePath);
    const locale = normalizeLocale(args.locale);
    const createIfMissing = args.createIfMissing ?? true;

    run.emitToolProgress({status: "loading_page", path, locale});
    const existing = await client.getPageByPath(path, locale);

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

      return buildPayload(
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
        `Archived wiki page ${locale}/${path} to ${archived.locale}/${archived.path}.`,
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
          if (!trimNonEmpty(args.title)) {
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

      return buildPayload(
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
        result.action === "created"
          ? `Created wiki page ${result.page.locale}/${result.page.path} with section ${sectionTitle}.`
          : sectionContent.action === "appended"
            ? `Added section ${sectionTitle} to wiki page ${result.page.locale}/${result.page.path}.`
            : `Updated section ${sectionTitle} in wiki page ${result.page.locale}/${result.page.path}.`,
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

    return buildPayload(
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
      result.action === "created"
        ? `Created wiki page ${result.page.locale}/${result.page.path}.`
        : `Updated wiki page ${result.page.locale}/${result.page.path}.`,
    );
  }
}
