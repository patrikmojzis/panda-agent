import {stat} from "node:fs/promises";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {assertPathReadable} from "../../lib/fs.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveContextPath} from "../../app/runtime/panda-path-context.js";
import type {EmailMessageRecipientRecord, EmailMessageRecord, EmailStore} from "../../domain/email/index.js";
import {EMAIL_CONNECTOR_KEY, EMAIL_SOURCE, normalizeEmailAddress} from "../../domain/email/index.js";
import type {EmailSendPayload, EmailSendRecipientPayload} from "../../domain/email/send-payload.js";
import type {OutboundFileItem, OutboundItem} from "../../domain/channels/types.js";
import {buildJsonToolPayload, rethrowAsToolError} from "./shared.js";

const MAX_EMAIL_ATTACHMENTS = 10;
const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_EMAIL_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const emailRecipientSchema = z.object({
  address: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});

const emailAttachmentSchema = z.object({
  path: z.string().trim().min(1),
  filename: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
});

const emailSendToolSchema = z.object({
  accountKey: z.string().trim().min(1),
  to: z.array(emailRecipientSchema).min(1).max(20).optional(),
  cc: z.array(emailRecipientSchema).max(20).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  replyToEmailId: z.string().trim().min(1).optional(),
  replyMode: z.enum(["sender", "all"]).optional(),
  text: z.string().trim().min(1),
  html: z.string().trim().min(1).optional(),
  attachments: z.array(emailAttachmentSchema).max(MAX_EMAIL_ATTACHMENTS).optional(),
}).superRefine((value, ctx) => {
  if (value.replyToEmailId) {
    if (value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to is not allowed when replyToEmailId is provided",
      });
    }
    if (value.cc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cc"],
        message: "cc is not allowed when replyToEmailId is provided",
      });
    }
    if (value.subject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "subject is derived when replyToEmailId is provided",
      });
    }
    return;
  }

  if (!value.to || value.to.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: "to is required for a fresh email",
    });
  }
  if (!value.subject) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject"],
      message: "subject is required for a fresh email",
    });
  }
  if (value.replyMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["replyMode"],
      message: "replyMode requires replyToEmailId",
    });
  }
});

export interface EmailSendToolOptions {
  store: EmailStore;
}

interface ResolvedEmailDraft {
  to: EmailSendRecipientPayload[];
  cc: EmailSendRecipientPayload[];
  subject: string;
  replyToEmailId?: string;
  inReplyTo?: string;
  references?: string;
  threadKey: string;
}

function ensureOutboundQueue(context: DefaultAgentSessionContext | undefined): NonNullable<DefaultAgentSessionContext["outboundQueue"]> {
  const queue = context?.outboundQueue;
  if (!queue) {
    throw new ToolError("Email send is unavailable in this runtime.");
  }

  return queue;
}

function requireContext(context: DefaultAgentSessionContext | undefined): DefaultAgentSessionContext {
  if (!context?.agentKey || !context.threadId) {
    throw new ToolError("Email send requires agentKey and threadId in the current runtime context.");
  }

  return context;
}

function normalizeRecipients(
  recipients: readonly z.output<typeof emailRecipientSchema>[] | undefined,
): EmailSendRecipientPayload[] {
  const seen = new Set<string>();
  const normalized: EmailSendRecipientPayload[] = [];
  for (const recipient of recipients ?? []) {
    const address = normalizeEmailAddress(recipient.address);
    if (seen.has(address)) {
      continue;
    }

    seen.add(address);
    normalized.push({
      address,
      ...(trimToUndefined(recipient.name) ? {name: trimToUndefined(recipient.name)} : {}),
    });
  }

  return normalized;
}

function stripOwnAndDedupe(
  recipients: readonly EmailSendRecipientPayload[],
  ownAddress: string,
): EmailSendRecipientPayload[] {
  const own = normalizeEmailAddress(ownAddress);
  const seen = new Set<string>();
  const deduped: EmailSendRecipientPayload[] = [];
  for (const recipient of recipients) {
    const address = normalizeEmailAddress(recipient.address);
    if (address === own || seen.has(address)) {
      continue;
    }

    seen.add(address);
    deduped.push({
      address,
      ...(trimToUndefined(recipient.name) ? {name: trimToUndefined(recipient.name)} : {}),
    });
  }

  return deduped;
}

function replySubject(message: EmailMessageRecord): string {
  const subject = trimToUndefined(message.subject) ?? "(no subject)";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function replyReferences(message: EmailMessageRecord): string | undefined {
  const parts = [
    ...(trimToUndefined(message.referencesHeader)?.split(/\s+/) ?? []),
    trimToUndefined(message.messageIdHeader),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? Array.from(new Set(parts)).join(" ") : undefined;
}

function recipientPayloadFromMessage(message: EmailMessageRecord): EmailSendRecipientPayload {
  const address = message.replyToAddress ?? message.fromAddress;
  if (!address) {
    throw new ToolError(`Email message ${message.id} has no sender or reply-to address.`);
  }

  return {
    address: normalizeEmailAddress(address),
    ...(message.fromName ? {name: message.fromName} : {}),
  };
}

function toPayloadRecipient(recipient: EmailMessageRecipientRecord): EmailSendRecipientPayload {
  return {
    address: recipient.address,
    ...(recipient.name ? {name: recipient.name} : {}),
  };
}

async function resolveAttachmentItems(
  attachments: readonly z.output<typeof emailAttachmentSchema>[] | undefined,
  run: RunContext<DefaultAgentSessionContext>,
): Promise<{
  items: OutboundFileItem[];
  payload: EmailSendPayload["attachments"];
}> {
  const items: OutboundFileItem[] = [];
  const payload: EmailSendPayload["attachments"] = [];
  let totalBytes = 0;

  for (const attachment of attachments ?? []) {
    const resolvedPath = resolveContextPath(attachment.path, run.context);
    await assertPathReadable(resolvedPath, (missingPath) => new ToolError(`No readable file found at ${missingPath}`));
    const stats = await stat(resolvedPath);
    if (!stats.isFile()) {
      throw new ToolError(`Email attachment ${resolvedPath} is not a file.`);
    }
    if (stats.size > MAX_EMAIL_ATTACHMENT_BYTES) {
      throw new ToolError(`Email attachment ${resolvedPath} exceeds the 20 MB per-file limit.`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
      throw new ToolError("Email attachments exceed the 50 MB total limit.");
    }

    const item: OutboundFileItem = {
      type: "file",
      path: resolvedPath,
      ...(attachment.filename ? {filename: attachment.filename} : {}),
      ...(attachment.mimeType ? {mimeType: attachment.mimeType} : {}),
    };
    items.push(item);
    payload.push({
      path: resolvedPath,
      ...(attachment.filename ? {filename: attachment.filename} : {}),
      ...(attachment.mimeType ? {mimeType: attachment.mimeType} : {}),
    });
  }

  return {items, payload};
}

export class EmailSendTool<TContext = DefaultAgentSessionContext> extends Tool<typeof emailSendToolSchema, TContext> {
  static schema = emailSendToolSchema;

  name = "email_send";
  description = [
    "Send a fresh email or reply from a configured Panda email account.",
    "Recipients must be exact allowlist matches.",
    "For replies, pass replyToEmailId and let Panda derive recipients, subject, and thread headers.",
  ].join("\n");
  schema = EmailSendTool.schema;

  private readonly store: EmailStore;

  constructor(options: EmailSendToolOptions) {
    super();
    this.store = options.store;
  }

  override formatCall(args: Record<string, unknown>): string {
    const accountKey = typeof args.accountKey === "string" ? args.accountKey : "account";
    const mode = typeof args.replyToEmailId === "string" ? "reply" : "new";
    return `${accountKey} ${mode}`;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!isRecord(details) || typeof details.deliveryId !== "string") {
      return super.formatResult(message);
    }

    return `Queued email delivery ${details.deliveryId}.`;
  }

  private async resolveDraft(
    args: z.output<typeof EmailSendTool.schema>,
    agentKey: string,
    fromAddress: string,
  ): Promise<ResolvedEmailDraft> {
    if (!args.replyToEmailId) {
      return {
        to: stripOwnAndDedupe(normalizeRecipients(args.to), fromAddress),
        cc: stripOwnAndDedupe(normalizeRecipients(args.cc), fromAddress),
        subject: args.subject!,
        threadKey: args.subject!,
      };
    }

    const message = await this.store.getMessage(args.replyToEmailId).catch((error: unknown) => rethrowAsToolError(error));
    if (message.agentKey !== agentKey || message.accountKey !== args.accountKey) {
      throw new ToolError(`Email message ${args.replyToEmailId} does not belong to account ${args.accountKey}.`);
    }

    const sender = recipientPayloadFromMessage(message);
    let cc: EmailSendRecipientPayload[] = [];
    if ((args.replyMode ?? "sender") === "all") {
      const originalRecipients = await this.store.listMessageRecipients(message.id);
      cc = originalRecipients
        .filter((recipient) => recipient.role === "to" || recipient.role === "cc")
        .map(toPayloadRecipient);
    }

    return {
      to: stripOwnAndDedupe([sender], fromAddress),
      cc: stripOwnAndDedupe(cc, fromAddress),
      subject: replySubject(message),
      replyToEmailId: message.id,
      inReplyTo: message.messageIdHeader,
      references: replyReferences(message),
      threadKey: message.threadKey,
    };
  }

  async handle(
    args: z.output<typeof EmailSendTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const context = requireContext(run.context as DefaultAgentSessionContext | undefined);
    const queue = ensureOutboundQueue(context);
    const account = await this.store.getAccount(context.agentKey, args.accountKey).catch((error: unknown) => rethrowAsToolError(error));
    if (!account.enabled) {
      throw new ToolError(`Email account ${args.accountKey} is disabled.`);
    }

    const draft = await this.resolveDraft(args, context.agentKey, account.fromAddress);
    const recipientAddresses = [...draft.to, ...draft.cc].map((recipient) => recipient.address);
    if (recipientAddresses.length === 0) {
      throw new ToolError("Email has no recipients after removing the sender account address.");
    }
    await this.store.assertRecipientsAllowed(context.agentKey, account.accountKey, recipientAddresses)
      .catch((error: unknown) => rethrowAsToolError(error));

    const attachments = await resolveAttachmentItems(args.attachments, run as RunContext<DefaultAgentSessionContext>);
    const payload: EmailSendPayload = {
      kind: "email_send",
      agentKey: context.agentKey,
      accountKey: account.accountKey,
      fromAddress: account.fromAddress,
      ...(account.fromName ? {fromName: account.fromName} : {}),
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      text: args.text,
      ...(args.html ? {html: args.html} : {}),
      attachments: attachments.payload,
      ...(draft.replyToEmailId ? {replyToEmailId: draft.replyToEmailId} : {}),
      ...(draft.inReplyTo ? {inReplyTo: draft.inReplyTo} : {}),
      ...(draft.references ? {references: draft.references} : {}),
      threadKey: draft.threadKey,
    };
    const items: OutboundItem[] = [
      {type: "text", text: args.text},
      ...attachments.items,
    ];
    const delivery = await queue.enqueueDelivery({
      threadId: context.threadId,
      channel: EMAIL_SOURCE,
      target: {
        source: EMAIL_SOURCE,
        connectorKey: EMAIL_CONNECTOR_KEY,
        externalConversationId: account.accountKey,
      },
      items,
      metadata: {
        email: payload as unknown as JsonObject,
      } satisfies JsonObject,
    });

    return buildJsonToolPayload({
      ok: true,
      status: "queued",
      deliveryId: delivery.id,
      channel: EMAIL_SOURCE,
      accountKey: account.accountKey,
      from: account.fromAddress,
    });
  }
}
