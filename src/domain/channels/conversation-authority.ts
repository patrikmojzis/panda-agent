import type {ConversationBinding, ConversationBindingListFilter} from "../sessions/conversations/types.js";
import {commandScopeDenied} from "../commands/errors.js";

export interface ConversationBindingAuthorizer {
  listConversationBindings(filter: ConversationBindingListFilter): Promise<readonly ConversationBinding[]>;
}

export async function assertCurrentSessionConversationBinding(input: {
  conversations: ConversationBindingAuthorizer;
  source: string;
  connectorKey: string;
  externalConversationId: string;
  sessionId: string;
  commandName: string;
}): Promise<ConversationBinding> {
  const bindings = await input.conversations.listConversationBindings({
    source: input.source,
    connectorKey: input.connectorKey,
  });
  const binding = bindings.find((candidate) =>
    candidate.sessionId === input.sessionId
    && candidate.externalConversationId === input.externalConversationId,
  );

  if (!binding) {
    throw commandScopeDenied(
      `${input.commandName} target conversation is not bound to the current session.`,
      "resource_scope_denied",
      "Use a conversation returned by the current session channel discovery command.",
    );
  }

  return binding;
}
