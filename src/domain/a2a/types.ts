export interface A2ASessionBindingLookup {
  senderSessionId: string;
  recipientSessionId: string;
}

export interface BindA2ASessionInput extends A2ASessionBindingLookup {}

export interface A2ASessionBindingRecord extends A2ASessionBindingLookup {
  createdAt: number;
  updatedAt: number;
}

export interface ListA2ASessionBindingsInput {
  senderSessionId?: string;
  recipientSessionId?: string;
}

export interface CountRecentA2AMessagesInput extends A2ASessionBindingLookup {
  since: number;
}
