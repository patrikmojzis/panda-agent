import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface CurrentEmailTableNames {
  prefix: string;
  emailAccounts: string;
  emailRecipientAllowRules: string;
  emailRoutes: string;
  emailMessages: string;
  emailMessageRecipients: string;
  emailAttachments: string;
}

/** Builds the current email relations without changing frozen migration dependencies. */
export function buildCurrentEmailTableNames(): CurrentEmailTableNames {
  return buildRuntimeRelationNames({
    emailAccounts: "email_accounts",
    emailRecipientAllowRules: "email_recipient_allow_rules",
    emailRoutes: "email_routes",
    emailMessages: "email_messages",
    emailMessageRecipients: "email_message_recipients",
    emailAttachments: "email_attachments",
  });
}
