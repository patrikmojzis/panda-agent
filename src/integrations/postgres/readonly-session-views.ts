import {READONLY_SESSION_VIEW_DEFINITIONS} from "../../domain/threads/runtime/postgres-readonly.js";

/** Current session-scoped views exposed through the restricted readonly role. */
export const CURRENT_READONLY_SESSION_VIEW_DEFINITIONS = Object.freeze({
  ...Object.fromEntries(
    Object.entries(READONLY_SESSION_VIEW_DEFINITIONS)
      .filter(([key]) => key !== "emailAllowedRecipients"),
  ),
  emailRecipientAllowRules: "email_recipient_allow_rules",
  scheduledCommands: "scheduled_commands",
  scheduledCommandRuns: "scheduled_command_runs",
});

export const CURRENT_READONLY_SESSION_VIEW_BASENAMES = Object.freeze(
  Object.values(CURRENT_READONLY_SESSION_VIEW_DEFINITIONS),
);
