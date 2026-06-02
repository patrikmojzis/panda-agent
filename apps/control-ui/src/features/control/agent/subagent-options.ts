export const subagentToolGroupOptions = [
  {
    label: "Core",
    value: "core",
    description: "Safe basics and parent A2A updates.",
  },
  {
    label: "Workspace read",
    value: "workspace_read",
    description: "Read-only workspace and artifact inspection.",
  },
  {
    label: "Internet",
    value: "internet",
    description: "Public web lookup, research, and browser inspection.",
  },
  {
    label: "Memory",
    value: "memory",
    description: "Read/query durable Panda memory surfaces.",
  },
  {
    label: "Execute",
    value: "execute",
    description: "Runtime execution and background job control.",
  },
  {
    label: "Skill maintenance",
    value: "skill_maintenance",
    description: "Durable skill create/update/delete access.",
  },
  {
    label: "Operate",
    value: "operate",
    description: "Operational mutation and control surfaces.",
  },
  {
    label: "Communicate human",
    value: "communicate_human",
    description: "Human/channel outbound communication surfaces.",
  },
]

export const subagentSourceFilterOptions = [
  { label: "Custom", value: "custom" },
  { label: "Builtin", value: "builtin" },
]
