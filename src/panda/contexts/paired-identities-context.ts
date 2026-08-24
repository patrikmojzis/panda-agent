import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {PairedIdentityDirectoryReader} from "../../domain/agents/paired-identity-directory.js";
import {
  MAX_PAIRED_IDENTITY_CHANNEL_HINTS,
  renderPairedIdentitiesContext,
  type PairedIdentityChannelHint,
  type PairedIdentityEntry,
} from "../../prompts/contexts/paired-identities.js";

const MAX_PAIRED_IDENTITIES_IN_PROMPT = 25;

export interface PairedIdentitiesContextOptions {
  sessionId: string;
  directory: PairedIdentityDirectoryReader;
}

export class PairedIdentitiesContext extends LlmContext {
  override name = "Paired Identities";

  private readonly options: PairedIdentitiesContextOptions;

  constructor(options: PairedIdentitiesContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const directoryEntries = await this.options.directory.listForSession({
      sessionId: this.options.sessionId,
      identityLimit: MAX_PAIRED_IDENTITIES_IN_PROMPT,
      bindingLimit: MAX_PAIRED_IDENTITY_CHANNEL_HINTS,
    });
    const entries = directoryEntries.map((entry): PairedIdentityEntry => {
      const channelHints = entry.bindings
        .map((binding): PairedIdentityChannelHint => ({
          source: binding.source,
          connectorKey: binding.connectorKey,
          externalActorId: binding.externalActorId,
        }));

      return {
        handle: entry.handle,
        displayName: entry.displayName,
        ...(entry.recentRoute ? {recentRoute: entry.recentRoute} : {}),
        channelHints,
        additionalChannelHintCount: entry.additionalBindingCount,
      };
    });

    return renderPairedIdentitiesContext(
      entries
        .sort((left, right) => left.handle.localeCompare(right.handle)),
    );
  }
}
