export const subagentToolGroupOptions = [
  {
    label: "Core",
    value: "core",
    description: "Safe basics and parent A2A updates.",
  },
  {
    label: "MCP",
    value: "mcp",
    description: "Configured agent MCP server discovery and tool calls.",
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

const subagentToolGroupValues = new Set(subagentToolGroupOptions.map((option) => option.value))

/** Keep API-provided tool groups within the options supported by this Control build. */
export function filterKnownSubagentToolGroups(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => subagentToolGroupValues.has(value)))]
}

export const subagentSourceFilterOptions = [
  { label: "Custom", value: "custom" },
  { label: "Builtin", value: "builtin" },
]
