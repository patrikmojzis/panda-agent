import {readdir, readFile} from "node:fs/promises";
import path from "node:path";

import {LlmContext} from "../../agent-core/llm-context.js";
import type {AgentStore} from "../../agents/store.js";
import {resolvePandaSkillsDir} from "../data-dir.js";

const AGENT_DOC_SLUGS = ["agent", "soul", "heartbeat", "playbook"] as const;
const RELATIONSHIP_DOC_SLUG = "memory";
const SKILL_FILENAMES = ["skill.md", "SKILL.md"] as const;

export interface AgentMemoryContextOptions {
  store: AgentStore;
  agentKey: string;
  identityId: string;
  skillsDir?: string;
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
    const sharedDocs = await Promise.all(
      AGENT_DOC_SLUGS.map(async (slug) => {
        const record = await this.options.store.readAgentDocument(this.options.agentKey, slug);
        return {
          slug,
          content: record?.content ?? "",
        };
      }),
    );
    const relationshipMemory = await this.options.store.readRelationshipDocument(
      this.options.agentKey,
      this.options.identityId,
      RELATIONSHIP_DOC_SLUG,
    );
    const recentDiary = [...await this.options.store.listDiaryEntries(
      this.options.agentKey,
      this.options.identityId,
      7,
    )].reverse();
    const skillEntries = await readSkillEntries(
      this.options.skillsDir ?? resolvePandaSkillsDir(this.options.agentKey),
    );

    return [
      `Agent key: ${this.options.agentKey}`,
      `Relationship identity: ${this.options.identityId}`,
      "",
      ...sharedDocs.flatMap((doc) => [
        `[${doc.slug}]`,
        doc.content || "(empty)",
        "",
      ]),
      "[memory]",
      relationshipMemory?.content || "(empty)",
      "",
      "[recent diary]",
      recentDiary.length === 0
        ? "(empty)"
        : recentDiary.map((entry) => `${entry.entryDate}\n${entry.content || "(empty)"}`).join("\n\n"),
      "",
      "[skills]",
      skillEntries.length === 0
        ? "(none)"
        : skillEntries.map((entry) => `${entry.name}\n${entry.content}`).join("\n\n"),
    ].join("\n");
  }
}
