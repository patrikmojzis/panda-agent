import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface ConnectorAccountTableNames {
  prefix: string;
  connectorAccounts: string;
  connectorAccountSecrets: string;
}

export function buildConnectorAccountTableNames(): ConnectorAccountTableNames {
  return buildRuntimeRelationNames({
    connectorAccounts: "connector_accounts",
    connectorAccountSecrets: "connector_account_secrets",
  });
}
