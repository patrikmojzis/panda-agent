import type {WikiBindingService} from "../../domain/wiki/service.js";
import {
  DEFAULT_WIKI_OVERVIEW_CACHE_TTL_MS,
  DEFAULT_WIKI_OVERVIEW_LINKED_LIMIT,
  selectWikiOverviewKeyPages,
  WikiOverviewReader,
} from "../../integrations/wiki/overview.js";
import {LlmContext} from "../../kernel/agent/llm-context.js";
import {renderWikiOverviewContext} from "../../prompts/contexts/wiki-overview.js";

export interface WikiOverviewContextOptions {
  agentKey: string;
  bindings: Pick<WikiBindingService, "getBinding">;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  locale?: string;
  keyPageLimit?: number;
  ttlMs?: number;
  now?: Date | (() => Date);
}

export class WikiOverviewContext extends LlmContext {
  override name = "Wiki Overview";

  private readonly options: WikiOverviewContextOptions;
  private readonly reader: WikiOverviewReader;

  constructor(options: WikiOverviewContextOptions) {
    super();
    this.options = options;
    this.reader = new WikiOverviewReader(options);
  }

  async getContent(): Promise<string> {
    try {
      const snapshot = await this.reader.read({
        agentKey: this.options.agentKey,
        locale: this.options.locale,
        recentLimit: 0,
        linkedLimit: this.options.keyPageLimit ?? DEFAULT_WIKI_OVERVIEW_LINKED_LIMIT,
        ttlMs: this.options.ttlMs ?? DEFAULT_WIKI_OVERVIEW_CACHE_TTL_MS,
      });
      if (!snapshot) {
        return "";
      }

      return renderWikiOverviewContext({
        namespacePath: snapshot.namespacePath,
        keyPages: selectWikiOverviewKeyPages(snapshot.topLinked),
      });
    } catch {
      // A flaky Wiki overview should not stop the whole agent from booting a prompt.
      return "";
    }
  }
}
