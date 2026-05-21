import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface EmailTableNames {
  prefix: string;
  emailAccounts: string;
  emailAllowedRecipients: string;
  emailRoutes: string;
  emailMessages: string;
  emailMessageRecipients: string;
  emailAttachments: string;
}

export function buildEmailTableNames(): EmailTableNames {
  return buildRuntimeRelationNames({
    emailAccounts: "email_accounts",
    emailAllowedRecipients: "email_allowed_recipients",
    emailRoutes: "email_routes",
    emailMessages: "email_messages",
    emailMessageRecipients: "email_message_recipients",
    emailAttachments: "email_attachments",
  });
}

