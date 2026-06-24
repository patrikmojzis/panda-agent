import type { SessionPromptSlug } from "@/lib/api"

export type SessionPromptMeta = {
  description: string
  label: string
  placeholder: string
  slug: SessionPromptSlug
}

export const SESSION_PROMPT_META: Record<SessionPromptSlug, SessionPromptMeta> = {
  brief: {
    description: "Normal session context.",
    label: "Brief",
    placeholder: "Add the session context the agent should keep using.",
    slug: "brief",
  },
  memory: {
    description: "Session-local memory.",
    label: "Memory",
    placeholder: "Add durable memory for this session.",
    slug: "memory",
  },
  heartbeat: {
    description: "Heartbeat wake guidance.",
    label: "Heartbeat",
    placeholder: "Add guidance used only when heartbeat wakes this session.",
    slug: "heartbeat",
  },
}
