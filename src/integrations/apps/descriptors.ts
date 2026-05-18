import {
  type AgentAppDefinition,
  readAgentAppRequiredInputKeys,
} from "../../domain/apps/types.js";

export function describeAgentAppSummary(app: AgentAppDefinition): {
  slug: string;
  name: string;
  description?: string;
  identityScoped: boolean;
  hasUi: boolean;
  viewNames: string[];
  actionNames: string[];
} {
  return {
    slug: app.slug,
    name: app.name,
    ...(app.description ? {description: app.description} : {}),
    identityScoped: app.identityScoped,
    hasUi: app.hasUi,
    viewNames: Object.keys(app.views),
    actionNames: Object.keys(app.actions),
  };
}

function describeAgentAppViews(app: AgentAppDefinition): Array<{
  name: string;
  description?: string;
  paginated: boolean;
}> {
  return Object.entries(app.views).map(([name, definition]) => ({
    name,
    ...(definition.description ? {description: definition.description} : {}),
    paginated: Boolean(definition.pagination),
  }));
}

function describeAgentAppActions(app: AgentAppDefinition): Array<{
  name: string;
  mode: string;
  description?: string;
  requiredInputKeys?: readonly string[];
  inputSchema?: unknown;
}> {
  return Object.entries(app.actions).map(([name, definition]) => {
    const requiredInputKeys = readAgentAppRequiredInputKeys(definition);
    return {
      name,
      mode: definition.mode ?? "native",
      ...(definition.description ? {description: definition.description} : {}),
      ...(requiredInputKeys?.length ? {requiredInputKeys} : {}),
      ...(definition.inputSchema ? {inputSchema: definition.inputSchema} : {}),
    };
  });
}

export function describeAgentAppDetails(app: AgentAppDefinition): ReturnType<typeof describeAgentAppSummary> & {
  views: ReturnType<typeof describeAgentAppViews>;
  actions: ReturnType<typeof describeAgentAppActions>;
} {
  return {
    ...describeAgentAppSummary(app),
    views: describeAgentAppViews(app),
    actions: describeAgentAppActions(app),
  };
}
