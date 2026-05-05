import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface EmailTableNames {
  prefix: string;
  emailAccounts: string;
  emailAllowedRecipients: string;
  emailMessages: string;
  emailMessageRecipients: string;
  emailAttachments: string;
}

export function buildEmailTableNames(): EmailTableNames {
  return buildRuntimeRelationNames({
    emailAccounts: "email_accounts",
    emailAllowedRecipients: "email_allowed_recipients",
    emailMessages: "email_messages",
    emailMessageRecipients: "email_message_recipients",
    emailAttachments: "email_attachments",
  });
}

