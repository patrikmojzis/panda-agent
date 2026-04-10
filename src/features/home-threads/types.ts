export interface HomeThreadMetadata {
  homeDir?: string;
}

export interface HomeThreadLookup {
  identityId: string;
}

export interface HomeThreadBindingInput extends HomeThreadLookup {
  threadId: string;
  metadata?: HomeThreadMetadata;
}

export interface HomeThreadRecord extends HomeThreadBindingInput {
  createdAt: number;
  updatedAt: number;
}

export interface BindHomeThreadResult {
  binding: HomeThreadRecord;
  previousThreadId?: string;
}
