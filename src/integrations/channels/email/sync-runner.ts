import {ImapFlow} from "imapflow";
import {type AddressObject, type ParsedMail, simpleParser} from "mailparser";

import {stringToUserMessage} from "../../../kernel/agent/index.js";
import type {JsonObject} from "../../../kernel/agent/types.js";
import type {CredentialResolver} from "../../../domain/credentials/index.js";
import type {SessionStore} from "../../../domain/sessions/index.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {
    EmailAccountRecord,
    EmailAccountSyncState,
    EmailAttachmentInput,
    EmailMessageRecord,
    EmailRecipientInput,
    EmailStore
} from "../../../domain/email/index.js";
import {
    DEFAULT_EMAIL_BACKFILL_LIMIT,
    normalizeEmailAddress,
    parseEmailAuthenticationResults
} from "../../../domain/email/index.js";
import {collapseWhitespace, trimToUndefined} from "../../../lib/strings.js";
import {renderEmailEventPrompt} from "../../../prompts/runtime/email-events.js";

const DEFAULT_EMAIL_POLL_INTERVAL_MS = 60_000;
const EMAIL_EVENT_SOURCE = "email_event";

export interface EmailSyncRunnerOptions {
  store: EmailStore;
  sessions: SessionStore;
  coordinator: ThreadRuntimeCoordinator;
  credentialResolver: CredentialResolver;
  pollIntervalMs?: number;
  backfillLimit?: number;
  syncAccount?: (account: EmailAccountRecord) => Promise<readonly EmailMessageRecord[]>;
  onError?: (error: unknown, accountKey?: string) => Promise<void> | void;
}

function addressEntries(value: AddressObject | AddressObject[] | undefined): Array<{address: string; name?: string}> {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((object) => object.value.flatMap((entry) => {
    if (!entry.address) {
      return [];
    }

    let address: string;
    try {
      address = normalizeEmailAddress(entry.address);
    } catch {
      return [];
    }

    return [{
      address,
      ...(trimToUndefined(entry.name) ? {name: trimToUndefined(entry.name)} : {}),
    }];
  }));
}

function firstAddress(value: AddressObject | AddressObject[] | undefined): {address: string; name?: string} | undefined {
  return addressEntries(value)[0];
}

function referencesHeader(value: ParsedMail["references"]): string | undefined {
  if (Array.isArray(value)) {
    return value.join(" ");
  }

  return trimToUndefined(value);
}

function bodyText(parsed: ParsedMail): string | undefined {
  const text = trimToUndefined(parsed.text);
  if (text) {
    return text;
  }

  if (typeof parsed.html === "string") {
    return collapseWhitespace(parsed.html.replace(/<[^>]*>/g, " ")) || undefined;
  }

  return undefined;
}

function recipients(parsed: ParsedMail): readonly EmailRecipientInput[] {
  const from = addressEntries(parsed.from).map((recipient) => ({
    role: "from" as const,
    ...recipient,
  }));
  const replyTo = addressEntries(parsed.replyTo).map((recipient) => ({
    role: "reply_to" as const,
    ...recipient,
  }));
  const to = addressEntries(parsed.to).map((recipient) => ({
    role: "to" as const,
    ...recipient,
  }));
  const cc = addressEntries(parsed.cc).map((recipient) => ({
    role: "cc" as const,
    ...recipient,
  }));

  return [...from, ...replyTo, ...to, ...cc];
}

function attachments(parsed: ParsedMail): readonly EmailAttachmentInput[] {
  return parsed.attachments.map((attachment) => ({
    filename: trimToUndefined(attachment.filename),
    mimeType: trimToUndefined(attachment.contentType),
    sizeBytes: attachment.size,
    contentId: trimToUndefined(attachment.contentId),
  }));
}

function headerValueToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return trimToUndefined(value);
  }
  if (Array.isArray(value)) {
    return trimToUndefined(value.map((entry) => String(entry)).join("\n"));
  }
  if (value === undefined || value === null) {
    return undefined;
  }

  return trimToUndefined(String(value));
}

function authenticationResultsHeader(parsed: ParsedMail): string | undefined {
  const value = parsed.headers.get("authentication-results");
  return headerValueToString(value);
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

function mailboxState(account: EmailAccountRecord, mailbox: string): {
  uidValidity?: string;
  lastUid?: number;
  initialized?: boolean;
} {
  const state = account.syncState.mailboxes?.[mailbox];
  if (!state || typeof state !== "object") {
    return {};
  }

  return state;
}

function updateMailboxState(
  state: EmailAccountSyncState,
  mailbox: string,
  next: {uidValidity?: string; lastUid?: number; initialized?: boolean},
): EmailAccountSyncState {
  return {
    ...state,
    mailboxes: {
      ...(state.mailboxes ?? {}),
      [mailbox]: {
        ...next,
      },
    },
  };
}

export class EmailSyncRunner {
  private readonly store: EmailStore;
  private readonly sessions: SessionStore;
  private readonly coordinator: ThreadRuntimeCoordinator;
  private readonly credentialResolver: CredentialResolver;
  private readonly pollIntervalMs: number;
  private readonly backfillLimit: number;
  private readonly syncAccountFn?: (account: EmailAccountRecord) => Promise<readonly EmailMessageRecord[]>;
  private readonly onError?: (error: unknown, accountKey?: string) => Promise<void> | void;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: EmailSyncRunnerOptions) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.coordinator = options.coordinator;
    this.credentialResolver = options.credentialResolver;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_EMAIL_POLL_INTERVAL_MS;
    this.backfillLimit = options.backfillLimit ?? DEFAULT_EMAIL_BACKFILL_LIMIT;
    this.syncAccountFn = options.syncAccount;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      void this.triggerDrain();
    }, this.pollIntervalMs);
    await this.triggerDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  async triggerDrain(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.drainPromise) {
      this.pendingDrain = true;
      return;
    }

    this.drainPromise = this.drain();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (this.pendingDrain && !this.stopped) {
        this.pendingDrain = false;
        await this.triggerDrain();
      }
    }
  }

  private async drain(): Promise<void> {
    const accounts = await this.store.listEnabledAccounts();
    for (const account of accounts) {
      if (this.stopped) {
        return;
      }

      try {
        const messages = this.syncAccountFn
          ? await this.syncAccountFn(account)
          : await this.syncAccount(account);
        for (const message of messages) {
          await this.wakeForMessage(account, message);
        }
      } catch (error) {
        await this.onError?.(error, account.accountKey);
      }
    }
  }

  private async syncAccount(account: EmailAccountRecord): Promise<readonly EmailMessageRecord[]> {
    const user = await resolveCredential(
      this.credentialResolver,
      account.agentKey,
      account.imap.usernameCredentialEnvKey,
    );
    const pass = await resolveCredential(
      this.credentialResolver,
      account.agentKey,
      account.imap.passwordCredentialEnvKey,
    );
    const imapPort = account.imap.port ?? (account.imap.secure === false ? 143 : 993);
    const client = new ImapFlow({
      host: account.imap.host,
      port: imapPort,
      secure: account.imap.secure ?? imapPort === 993,
      logger: false,
      auth: {
        user,
        pass,
      },
    });

    try {
      await client.connect();
      let accountState = account.syncState;
      const visibleMessages: EmailMessageRecord[] = [];

      for (const mailbox of account.mailboxes) {
        const messages = await this.syncMailbox(client, account, mailbox, accountState);
        accountState = messages.nextState;
        visibleMessages.push(...messages.visible);
      }

      await this.store.updateAccountSyncState(account.agentKey, account.accountKey, accountState);
      return visibleMessages;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async syncMailbox(
    client: ImapFlow,
    account: EmailAccountRecord,
    mailbox: string,
    accountState: EmailAccountSyncState,
  ): Promise<{visible: EmailMessageRecord[]; nextState: EmailAccountSyncState}> {
    const lock = await client.getMailboxLock(mailbox, {readOnly: true});
    try {
      const opened = client.mailbox;
      if (!opened) {
        throw new Error(`Email mailbox ${mailbox} did not open correctly.`);
      }

      const uidValidity = String(opened.uidValidity);
      const previous = mailboxState({...account, syncState: accountState}, mailbox);
      const initialized = previous.initialized === true && previous.uidValidity === uidValidity;
      const lastUid = initialized && typeof previous.lastUid === "number" ? Math.floor(previous.lastUid) : undefined;
      const exists = Number(opened.exists ?? 0);
      if (exists <= 0) {
        return {
          visible: [],
          nextState: updateMailboxState(accountState, mailbox, {
            uidValidity,
            lastUid: 0,
            initialized: true,
          }),
        };
      }

      const range = initialized && lastUid !== undefined
        ? `${lastUid + 1}:*`
        : `${Math.max(1, exists - this.backfillLimit + 1)}:*`;
      const visible: EmailMessageRecord[] = [];
      let maxUid = lastUid ?? 0;

      for await (const message of client.fetch(range, {
        uid: true,
        source: true,
        internalDate: true,
      }, {
        uid: initialized,
      })) {
        const uid = Number(message.uid);
        if (!Number.isFinite(uid)) {
          continue;
        }
        maxUid = Math.max(maxUid, uid);
        if (!message.source) {
          continue;
        }

        const parsed = await simpleParser(message.source);
        const authResultsHeader = authenticationResultsHeader(parsed);
        const auth = parseEmailAuthenticationResults(authResultsHeader);
        const from = firstAddress(parsed.from);
        const replyTo = firstAddress(parsed.replyTo);
        const receivedAt = parsed.date instanceof Date
          ? parsed.date.getTime()
          : message.internalDate instanceof Date
            ? message.internalDate.getTime()
            : new Date(String(message.internalDate ?? Date.now())).getTime();
        const recorded = await this.store.recordMessage({
          agentKey: account.agentKey,
          accountKey: account.accountKey,
          direction: "inbound",
          mailbox,
          uid,
          uidValidity,
          messageIdHeader: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          referencesHeader: referencesHeader(parsed.references),
          subject: parsed.subject,
          fromName: from?.name,
          fromAddress: from?.address,
          replyToAddress: replyTo?.address,
          receivedAt,
          bodyText: bodyText(parsed),
          authenticationResults: authResultsHeader,
          ...auth,
          recipients: recipients(parsed),
          attachments: attachments(parsed),
        });
        if (initialized && recorded.inserted) {
          visible.push(recorded.message);
        }
      }

      return {
        visible,
        nextState: updateMailboxState(accountState, mailbox, {
          uidValidity,
          lastUid: maxUid,
          initialized: true,
        }),
      };
    } finally {
      lock.release();
    }
  }

  private async wakeForMessage(account: EmailAccountRecord, message: EmailMessageRecord): Promise<void> {
    const session = await this.sessions.getMainSession(account.agentKey);
    if (!session?.currentThreadId) {
      return;
    }

    const metadata: JsonObject = {
      emailEvent: {
        accountKey: account.accountKey,
        emailId: message.id,
        receivedAt: message.receivedAt ? new Date(message.receivedAt).toISOString() : null,
      },
    };
    await this.coordinator.submitInput(session.currentThreadId, {
      message: stringToUserMessage(renderEmailEventPrompt({
        accountKey: account.accountKey,
        messageId: message.id,
        fromAddress: message.fromAddress,
        subject: message.subject,
        receivedIso: message.receivedAt ? new Date(message.receivedAt).toISOString() : undefined,
        authSummary: message.authSummary,
        authSpf: message.authSpf,
        authDkim: message.authDkim,
        authDmarc: message.authDmarc,
      })),
      source: EMAIL_EVENT_SOURCE,
      externalMessageId: message.id,
      metadata,
    });
  }
}
