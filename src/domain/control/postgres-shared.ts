import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface ControlTableNames {
  prefix: string;
  grants: string;
  sessions: string;
  auditEvents: string;
}

export function buildControlTableNames(): ControlTableNames {
  return buildRuntimeRelationNames({
    grants: "control_grants",
    sessions: "control_sessions",
    auditEvents: "control_audit_events",
  });
}
