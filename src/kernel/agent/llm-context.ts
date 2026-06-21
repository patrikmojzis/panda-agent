import {renderLlmContextDump} from "../../prompts/contexts/llm-context.js";

const LLM_CONTEXT_SECTION_PREVIEW_CHARS = 500;

export interface LlmContextSnapshot {
  content: string;
  promptCacheKeyPart?: string | null;
  source?: string | null;
  label?: string | null;
}

export interface LlmContextRuntimeSection {
  name: string;
  source?: string;
  label?: string;
  content: string;
  contentPreview: string;
  contentChars: number;
  estimatedTokens: number;
  dump: string;
  dumpChars: number;
  promptCacheKeyPart?: string;
}

export interface LlmContextRuntimeDump {
  dump: string;
  sections: readonly LlmContextRuntimeSection[];
  promptCacheKeyParts: readonly string[];
}

export abstract class LlmContext {
  name = this.constructor.name;
  source?: string | null;
  label?: string | null;

  abstract getContent(): Promise<string>;

  async getSnapshot(): Promise<LlmContextSnapshot> {
    return {content: await this.getContent()};
  }

  async dumps(): Promise<string> {
    const {content} = await this.getSnapshot();
    if (content.trim().length === 0) {
      return "";
    }

    return renderLlmContextDump(this.name, content);
  }
}

export async function gatherContexts(contexts: LlmContext[]): Promise<string> {
  const result = await gatherContextsForRuntime(contexts);
  return result.dump;
}

function metadataString(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function previewContent(value: string): string {
  if (value.length <= LLM_CONTEXT_SECTION_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, LLM_CONTEXT_SECTION_PREVIEW_CHARS - 1).trimEnd()}…`;
}

function estimateTokens(value: string): number {
  return value.trim().length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4));
}

export async function gatherContextsForRuntime(contexts: LlmContext[]): Promise<LlmContextRuntimeDump> {
  const results = await Promise.all(contexts.map(async (context) => {
    const snapshot = await context.getSnapshot();
    const content = snapshot.content;
    const dump = content.trim().length > 0 ? renderLlmContextDump(context.name, content) : "";
    return {
      name: context.name,
      source: metadataString(snapshot.source, context.source),
      label: metadataString(snapshot.label, context.label),
      content,
      contentPreview: previewContent(content),
      contentChars: content.length,
      estimatedTokens: estimateTokens(content),
      dump,
      dumpChars: dump.length,
      promptCacheKeyPart: snapshot.promptCacheKeyPart?.trim() || undefined,
    };
  }));
  return {
    dump: results
      .map((result) => result.dump)
      .filter((result) => result.trim().length > 0)
      .join("\n\n"),
    sections: results
      .filter((result) => result.dump.trim().length > 0)
      .map((result) => ({
        name: result.name,
        ...(result.source ? {source: result.source} : {}),
        ...(result.label ? {label: result.label} : {}),
        content: result.content,
        contentPreview: result.contentPreview,
        contentChars: result.contentChars,
        estimatedTokens: result.estimatedTokens,
        dump: result.dump,
        dumpChars: result.dumpChars,
        ...(result.promptCacheKeyPart ? {promptCacheKeyPart: result.promptCacheKeyPart} : {}),
      })),
    promptCacheKeyParts: results
      .map((result) => result.promptCacheKeyPart)
      .filter((part): part is string => part !== undefined),
  };
}
