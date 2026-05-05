import type {SendMailOptions, SentMessageInfo} from "nodemailer";
import nodemailer from "nodemailer";
import {stat} from "node:fs/promises";

import type {CredentialResolver} from "../../../domain/credentials/index.js";
import type {
    ChannelOutboundAdapter,
    OutboundRequest,
    OutboundResult,
    OutboundSentItem
} from "../../../domain/channels/index.js";
import type {EmailSendPayload, EmailSendRecipientPayload} from "../../../domain/email/send-payload.js";
import type {EmailStore} from "../../../domain/email/index.js";
import {EMAIL_CONNECTOR_KEY, EMAIL_SOURCE, normalizeEmailAddress} from "../../../domain/email/index.js";
import {isRecord} from "../../../lib/records.js";
import {assertPathReadable} from "../../../lib/fs.js";

const MAX_EMAIL_ATTACHMENTS = 10;
const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_EMAIL_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface EmailSendMailInput {
  account: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  message: SendMailOptions;
}

export interface EmailSendMailResult {
  messageId?: string;
}

export interface CreateEmailOutboundAdapterOptions {
  store: EmailStore;
  credentialResolver: CredentialResolver;
  sendMail?: (input: EmailSendMailInput) => Promise<EmailSendMailResult>;
}

function requireEmailPayload(request: OutboundRequest): EmailSendPayload {
  const metadata = request.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.email)) {
    throw new Error("Email outbound delivery is missing email metadata.");
  }

  const payload = metadata.email;
  if (
    payload.kind !== "email_send"
    || typeof payload.agentKey !== "string"
    || typeof payload.accountKey !== "string"
    || typeof payload.fromAddress !== "string"
    || typeof payload.subject !== "string"
    || typeof payload.text !== "string"
    || typeof payload.threadKey !== "string"
    || !Array.isArray(payload.to)
    || !Array.isArray(payload.cc)
    || !Array.isArray(payload.attachments)
    || !payload.to.every(isEmailRecipientPayload)
    || !payload.cc.every(isEmailRecipientPayload)
    || !payload.attachments.every(isEmailAttachmentPayload)
  ) {
    throw new Error("Email outbound delivery metadata is invalid.");
  }

  return payload as unknown as EmailSendPayload;
}

function isEmailRecipientPayload(value: unknown): value is EmailSendRecipientPayload {
  return isRecord(value)
    && typeof value.address === "string"
    && (value.name === undefined || typeof value.name === "string");
}

function isEmailAttachmentPayload(value: unknown): value is EmailSendPayload["attachments"][number] {
  return isRecord(value)
    && typeof value.path === "string"
    && (value.filename === undefined || typeof value.filename === "string")
    && (value.mimeType === undefined || typeof value.mimeType === "string");
}

function formatAddress(recipient: EmailSendRecipientPayload): string | {address: string; name: string} {
  const address = normalizeEmailAddress(recipient.address);
  return recipient.name ? {address, name: recipient.name} : address;
}

function fromAddress(payload: EmailSendPayload): string | {address: string; name: string} {
  const address = normalizeEmailAddress(payload.fromAddress);
  return payload.fromName ? {address, name: payload.fromName} : address;
}

function assertPayloadMatchesAccount(payload: EmailSendPayload, account: {fromAddress: string}): void {
  if (normalizeEmailAddress(payload.fromAddress) !== account.fromAddress) {
    throw new Error(`Email outbound from address does not match account ${payload.accountKey}.`);
  }
}

async function resolveCredential(
  resolver: CredentialResolver,
  agentKey: string,
  envKey: string,
): Promise<string> {
  const record = await resolver.resolveCredential(envKey, {agentKey});
  if (!record) {
    throw new Error(`Missing email credential ${envKey}.`);
  }

  return record.value;
}

async function defaultSendMail(input: EmailSendMailInput): Promise<EmailSendMailResult> {
  const transport = nodemailer.createTransport({
    host: input.account.host,
    port: input.account.port,
    secure: input.account.secure,
    auth: {
      user: input.account.user,
      pass: input.account.pass,
    },
  });
  const result = await transport.sendMail(input.message) as SentMessageInfo;
  const messageId = typeof result.messageId === "string" ? result.messageId : undefined;
  return {
    ...(messageId ? {messageId} : {}),
  };
}

function sentItems(request: OutboundRequest, externalMessageId: string): readonly OutboundSentItem[] {
  return request.items.map((item) => ({
    type: item.type,
    externalMessageId,
  }));
}

async function assertAttachmentsSafe(payload: EmailSendPayload): Promise<void> {
  if (payload.attachments.length > MAX_EMAIL_ATTACHMENTS) {
    throw new Error(`Email has too many attachments; max ${MAX_EMAIL_ATTACHMENTS}.`);
  }

  let totalBytes = 0;
  for (const attachment of payload.attachments) {
    if (!attachment.path || typeof attachment.path !== "string") {
      throw new Error("Email attachment path is missing.");
    }

    await assertPathReadable(attachment.path);
    const stats = await stat(attachment.path);
    if (!stats.isFile()) {
      throw new Error(`Email attachment ${attachment.path} is not a file.`);
    }
    if (stats.size > MAX_EMAIL_ATTACHMENT_BYTES) {
      throw new Error(`Email attachment ${attachment.path} exceeds the 20 MB per-file limit.`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Email attachments exceed the 50 MB total limit.");
    }
  }
}

export function createEmailOutboundAdapter(options: CreateEmailOutboundAdapterOptions): ChannelOutboundAdapter {
  const sendMail = options.sendMail ?? defaultSendMail;

  return {
    channel: EMAIL_SOURCE,
    async send(request: OutboundRequest): Promise<OutboundResult> {
      if (request.target.connectorKey !== EMAIL_CONNECTOR_KEY) {
        throw new Error(`Email outbound requires connector key ${EMAIL_CONNECTOR_KEY}.`);
      }

      const payload = requireEmailPayload(request);
      const account = await options.store.getAccount(payload.agentKey, payload.accountKey);
      if (!account.enabled) {
        throw new Error(`Email account ${payload.accountKey} is disabled.`);
      }
      assertPayloadMatchesAccount(payload, account);
      const recipients = [...payload.to, ...payload.cc].map((recipient) => recipient.address);
      await options.store.assertRecipientsAllowed(payload.agentKey, payload.accountKey, recipients);
      await assertAttachmentsSafe(payload);

      const user = await resolveCredential(
        options.credentialResolver,
        payload.agentKey,
        account.smtp.usernameCredentialEnvKey,
      );
      const pass = await resolveCredential(
        options.credentialResolver,
        payload.agentKey,
        account.smtp.passwordCredentialEnvKey,
      );
      const smtpPort = account.smtp.port ?? (account.smtp.secure === false ? 587 : 465);
      const accountFromPayload: EmailSendPayload = {
        ...payload,
        fromAddress: account.fromAddress,
        ...(account.fromName ? {fromName: account.fromName} : {}),
      };
      const result = await sendMail({
        account: {
          host: account.smtp.host,
          port: smtpPort,
          secure: account.smtp.secure ?? smtpPort === 465,
          user,
          pass,
        },
        message: {
          from: fromAddress(accountFromPayload),
          to: payload.to.map(formatAddress),
          ...(payload.cc.length > 0 ? {cc: payload.cc.map(formatAddress)} : {}),
          subject: payload.subject,
          text: payload.text,
          ...(payload.html ? {html: payload.html} : {}),
          ...(payload.inReplyTo ? {inReplyTo: payload.inReplyTo} : {}),
          ...(payload.references ? {references: payload.references} : {}),
          attachments: payload.attachments.map((attachment) => ({
            path: attachment.path,
            ...(attachment.filename ? {filename: attachment.filename} : {}),
            ...(attachment.mimeType ? {contentType: attachment.mimeType} : {}),
          })),
        },
      });
      const externalMessageId = result.messageId ?? request.deliveryId ?? `email:${Date.now()}`;
      await options.store.recordMessage({
        agentKey: payload.agentKey,
        accountKey: payload.accountKey,
        direction: "outbound",
        messageIdHeader: result.messageId,
        inReplyTo: payload.inReplyTo,
        referencesHeader: payload.references,
        threadKey: payload.threadKey,
        subject: payload.subject,
        fromName: account.fromName,
        fromAddress: account.fromAddress,
        sentAt: Date.now(),
        bodyText: payload.text,
        sourceDeliveryId: request.deliveryId,
        recipients: [
          {role: "from", address: account.fromAddress, name: account.fromName},
          ...payload.to.map((recipient) => ({role: "to" as const, ...recipient})),
          ...payload.cc.map((recipient) => ({role: "cc" as const, ...recipient})),
        ],
        attachments: payload.attachments.map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          localPath: attachment.path,
        })),
      });

      return {
        ok: true,
        channel: request.channel,
        target: request.target,
        sent: sentItems(request, externalMessageId),
      };
    },
  };
}
