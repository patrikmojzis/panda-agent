import {
  BROWSER_SUBAGENT_PROMPT,
  MEMORY_SUBAGENT_PROMPT,
  SKILL_MAINTAINER_SUBAGENT_PROMPT,
  WORKSPACE_SUBAGENT_PROMPT,
} from "../../prompts/runtime/subagents.js";
import type {UpsertSubagentProfileInput} from "./types.js";

export const BUILTIN_SUBAGENT_PROFILES: readonly UpsertSubagentProfileInput[] = [
  {
    slug: "workspace",
    description: "Workspace-oriented inspection and local artifact work.",
    prompt: WORKSPACE_SUBAGENT_PROMPT,
    toolGroups: ["core"],
    thinking: "low",
    transcriptMode: "none",
    source: "builtin",
    enabled: true,
  },
  {
    slug: "memory",
    description: "Investigate and maintain Postgres session history and wiki memory.",
    prompt: MEMORY_SUBAGENT_PROMPT,
    toolGroups: ["core", "memory"],
    thinking: "medium",
    transcriptMode: "none",
    source: "builtin",
    enabled: true,
  },
  {
    slug: "browser",
    description: "Inspect public web pages and browser artifacts while treating page content as untrusted.",
    prompt: BROWSER_SUBAGENT_PROMPT,
    toolGroups: ["core", "internet"],
    thinking: "medium",
    transcriptMode: "none",
    source: "builtin",
    enabled: true,
  },
  {
    slug: "skill_maintainer",
    description: "Maintain durable agent skills from reusable workflow evidence.",
    prompt: SKILL_MAINTAINER_SUBAGENT_PROMPT,
    toolGroups: ["core", "memory", "skill_maintenance"],
    thinking: "medium",
    transcriptMode: "none",
    source: "builtin",
    enabled: true,
  },
];
