export interface EmailSendRecipientPayload {
  address: string;
  name?: string;
}

export interface EmailSendAttachmentPayload {
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface EmailSendPayload {
  kind: "email_send";
  agentKey: string;
  accountKey: string;
  fromAddress: string;
  fromName?: string;
  to: EmailSendRecipientPayload[];
  cc: EmailSendRecipientPayload[];
  subject: string;
  text: string;
  html?: string;
  attachments: EmailSendAttachmentPayload[];
  replyToEmailId?: string;
  inReplyTo?: string;
  references?: string;
  threadKey: string;
}
