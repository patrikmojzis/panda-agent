import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface WikiBindingTableNames {
  wikiBindings: string;
}

export function buildWikiBindingTableNames(): WikiBindingTableNames {
  return buildRuntimeRelationNames({
    wikiBindings: "agent_wiki_bindings",
  });
}
