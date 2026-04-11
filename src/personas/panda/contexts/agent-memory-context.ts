import {readdir, readFile} from "node:fs/promises";
import path from "node:path";

import {LlmContext} from "../../../kernel/agent/llm-context.js";
import {
    type AgentWorkspaceDiaryEntry,
    type AgentWorkspaceDocSection,
    type AgentWorkspaceSkillEntry,
    renderAgentWorkspaceContext,
} from "../../../prompts/contexts/agent-workspace.js";
import type {AgentStore} from "../../../domain/agents/store.js";
import {resolvePandaSkillsDir} from "../../../app/runtime/data-dir.js";

// Heartbeat guidance should only show up on heartbeat wakes, not in every normal run.
const AGENT_DOC_SLUGS = ["agent", "soul", "playbook"] as const;
const RELATIONSHIP_DOC_SLUG = "memory";
const SKILL_FILENAMES = ["skill.md", "SKILL.md"] as const;

export type AgentMemoryContextSection =
  | "agent_docs"
  | "relationship_memory"
  | "diary"
  | "skills";

export interface AgentMemoryContextOptions {
  store: AgentStore;
  agentKey: string;
  identityId: string;
  skillsDir?: string;
  sections?: readonly AgentMemoryContextSection[];
}

async function readFirstExistingSkillFile(skillDir: string): Promise<string | null> {
  for (const fileName of SKILL_FILENAMES) {
    try {
      return await readFile(path.join(skillDir, fileName), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

async function readSkillEntries(skillsDir: string): Promise<Array<{ name: string; content: string }>> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const loaded = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const content = await readFirstExistingSkillFile(path.join(skillsDir, entry.name));
        if (content === null) {
          return null;
        }

        return {
          name: entry.name,
          content,
        };
      }));

    return loaded.filter((entry): entry is { name: string; content: string } => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export class AgentMemoryContext extends LlmContext {
  override name = "Agent Workspace";

  private readonly options: AgentMemoryContextOptions;

  constructor(options: AgentMemoryContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const sections = new Set<AgentMemoryContextSection>(
      this.options.sections ?? ["agent_docs", "relationship_memory", "diary", "skills"],
    );
    let agentDocs: AgentWorkspaceDocSection[] | undefined;
    let relationshipMemory: string | undefined;
    let recentDiary: AgentWorkspaceDiaryEntry[] | undefined;
    let skills: AgentWorkspaceSkillEntry[] | undefined;

    if (sections.has("agent_docs")) {
      agentDocs = await Promise.all(
        AGENT_DOC_SLUGS.map(async (slug) => {
          const record = await this.options.store.readAgentDocument(this.options.agentKey, slug);
          return {
            slug,
            content: record?.content ?? "",
          };
        }),
      );
    }

    if (sections.has("relationship_memory")) {
      const record = await this.options.store.readRelationshipDocument(
        this.options.agentKey,
        this.options.identityId,
        RELATIONSHIP_DOC_SLUG,
      );
      relationshipMemory = record?.content ?? "";
    }

    if (sections.has("diary")) {
      recentDiary = [...await this.options.store.listDiaryEntries(
        this.options.agentKey,
        this.options.identityId,
        7,
      )].reverse().map((entry) => ({
        entryDate: entry.entryDate,
        content: entry.content || "",
      }));
    }

    if (sections.has("skills")) {
      skills = await readSkillEntries(
        this.options.skillsDir ?? resolvePandaSkillsDir(this.options.agentKey),
      );
    }

    return renderAgentWorkspaceContext({
      agentKey: this.options.agentKey,
      identityId: this.options.identityId,
      agentDocs,
      relationshipMemory,
      recentDiary,
      skills,
    });
  }
}
