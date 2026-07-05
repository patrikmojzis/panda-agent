import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {CommandDescriptor} from "../../domain/commands/types.js";
import {DEFAULT_AGENT_COMMAND_DESCRIPTORS} from "../commands/agent-command-descriptors.js";
import {renderCommandCatalogContext} from "../../prompts/contexts/command-catalog.js";

export interface CommandCatalogContextOptions {
  descriptors?: readonly CommandDescriptor[];
}

export class CommandCatalogContext extends LlmContext {
  override name = "Panda CLI Catalog";

  private readonly descriptors: readonly CommandDescriptor[];

  constructor(options: CommandCatalogContextOptions = {}) {
    super();
    this.descriptors = options.descriptors ?? DEFAULT_AGENT_COMMAND_DESCRIPTORS;
  }

  async getContent(): Promise<string> {
    return renderCommandCatalogContext(this.descriptors.map((descriptor) => ({
      name: descriptor.name,
      summary: descriptor.summary,
      usage: descriptor.usage,
    })));
  }
}
