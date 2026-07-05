import type {ConversationBinding, ConversationBindingListFilter} from "../sessions/conversations/types.js";

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
    throw new Error(
      `${input.commandName} target conversation ${input.externalConversationId} is not bound to the current session.`,
    );
  }

  return binding;
}
