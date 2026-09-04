import type {ConversationRepo} from "../sessions/conversations/repo.js";
import type {ConversationBinding} from "../sessions/conversations/types.js";
import {commandScopeDenied} from "../commands/errors.js";

export type ConversationBindingAuthorizer = Pick<ConversationRepo, "getConversationBinding">;

export async function assertCurrentSessionConversationBinding(input: {
  conversations: ConversationBindingAuthorizer;
  source: string;
  connectorKey: string;
  externalConversationId: string;
  sessionId: string;
  commandName: string;
}): Promise<ConversationBinding> {
  const binding = await input.conversations.getConversationBinding({
    source: input.source,
    connectorKey: input.connectorKey,
    externalConversationId: input.externalConversationId,
  });

  if (!binding || binding.sessionId !== input.sessionId) {
    throw commandScopeDenied(
      `${input.commandName} target conversation is not bound to the current session.`,
      "resource_scope_denied",
      "Use a conversation returned by the current session channel discovery command.",
    );
  }

  return binding;
}
