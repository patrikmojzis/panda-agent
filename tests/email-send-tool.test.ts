import {describe, expect, it} from "vitest";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {Agent, RunContext} from "../src/kernel/agent/index.js";
import {EmailSendTool} from "../src/panda/index.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import type {
    EmailAccountRecord,
    EmailAccountSyncState,
    EmailAllowedRecipientRecord,
    EmailMessageRecipientRecord,
    EmailMessageRecord,
    EmailStore,
    RecordEmailMessageInput,
    RecordEmailMessageResult,
    UpsertEmailAccountInput,
} from "../src/domain/email/index.js";
import {normalizeEmailAddress} from "../src/domain/email/index.js";

class MemoryEmailStore implements EmailStore {
  account: EmailAccountRecord = {
    agentKey: "panda",
    accountKey: "work",
    fromAddress: "panda@example.com",
    imap: {
      host: "imap.example.com",
      usernameCredentialEnvKey: "IMAP_USER",
      passwordCredentialEnvKey: "IMAP_PASS",
    },
    smtp: {
      host: "smtp.example.com",
      usernameCredentialEnvKey: "SMTP_USER",
      passwordCredentialEnvKey: "SMTP_PASS",
    },
    mailboxes: ["INBOX"],
    syncState: {},
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  allowed = new Set<string>();
  messages = new Map<string, EmailMessageRecord>();
  recipients = new Map<string, EmailMessageRecipientRecord[]>();

  async ensureSchema(): Promise<void> {}
  async upsertAccount(_input: UpsertEmailAccountInput): Promise<EmailAccountRecord> {
    return this.account;
  }
  async disableAccount(): Promise<EmailAccountRecord> {
    this.account = {...this.account, enabled: false};
    return this.account;
  }
  async getAccount(agentKey: string, accountKey: string): Promise<EmailAccountRecord> {
    if (agentKey !== this.account.agentKey || accountKey !== this.account.accountKey) {
      throw new Error(`Unknown email account ${accountKey}`);
    }

    return this.account;
  }
  async listEnabledAccounts(): Promise<readonly EmailAccountRecord[]> {
    return [this.account];
  }
  async updateAccountSyncState(_agentKey: string, _accountKey: string, syncState: EmailAccountSyncState): Promise<EmailAccountRecord> {
    this.account = {...this.account, syncState};
    return this.account;
  }
  async addAllowedRecipient(agentKey: string, accountKey: string, address: string): Promise<EmailAllowedRecipientRecord> {
    const normalized = normalizeEmailAddress(address);
    this.allowed.add(normalized);
    return {agentKey, accountKey, address: normalized, createdAt: 1};
  }
  async removeAllowedRecipient(_agentKey: string, _accountKey: string, address: string): Promise<boolean> {
    return this.allowed.delete(normalizeEmailAddress(address));
  }
  async listAllowedRecipients(agentKey: string, accountKey: string): Promise<readonly EmailAllowedRecipientRecord[]> {
    return Array.from(this.allowed).map((address) => ({agentKey, accountKey, address, createdAt: 1}));
  }
  async assertRecipientsAllowed(_agentKey: string, accountKey: string, addresses: readonly string[]): Promise<void> {
    const blocked = addresses
      .map((address) => normalizeEmailAddress(address))
      .filter((address) => !this.allowed.has(address));
    if (blocked.length > 0) {
      throw new Error(`Email account ${accountKey} is not allowed to send to ${blocked.join(", ")}.`);
    }
  }
  async recordMessage(_input: RecordEmailMessageInput): Promise<RecordEmailMessageResult> {
    throw new Error("unused");
  }
  async getMessage(messageId: string): Promise<EmailMessageRecord> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown email message ${messageId}`);
    }

    return message;
  }
  async listMessageRecipients(messageId: string): Promise<readonly EmailMessageRecipientRecord[]> {
    return this.recipients.get(messageId) ?? [];
  }
}

function createContext(): DefaultAgentSessionContext & {queued: unknown[]} {
  const queued: unknown[] = [];
  let deliveryCount = 0;
  return {
    agentKey: "panda",
    sessionId: "session-1",
    threadId: "thread-1",
    cwd: process.cwd(),
    queued,
    outboundQueue: {
      enqueueDelivery: async (input) => {
        queued.push(input);
        deliveryCount += 1;
        return {
          id: `delivery-${deliveryCount}`,
          status: "pending",
          attemptCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...input,
        };
      },
    },
  };
}

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent(),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

describe("EmailSendTool", () => {
  it("queues a fresh allowlisted email", async () => {
    const store = new MemoryEmailStore();
    await store.addAllowedRecipient("panda", "work", "alice@example.com");
    const context = createContext();
    const tool = new EmailSendTool<DefaultAgentSessionContext>({store});

    const result = await tool.run({
      accountKey: "work",
      to: [{address: "ALICE@example.com", name: "Alice"}],
      subject: "Deploy update",
      text: "The deploy step is failing.",
    }, createRunContext(context));

    expect(result.details).toMatchObject({
      status: "queued",
      channel: "email",
      accountKey: "work",
      from: "panda@example.com",
    });
    expect(context.queued).toEqual([expect.objectContaining({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      metadata: {
        email: expect.objectContaining({
          accountKey: "work",
          to: [{address: "alice@example.com", name: "Alice"}],
          subject: "Deploy update",
          text: "The deploy step is failing.",
        }),
      },
    })]);
  });

  it("derives reply-all recipients and threading headers from stored email", async () => {
    const store = new MemoryEmailStore();
    for (const address of ["alice@example.com", "bob@example.com", "carol@example.com"]) {
      await store.addAllowedRecipient("panda", "work", address);
    }
    store.messages.set("email-1", {
      id: "email-1",
      agentKey: "panda",
      accountKey: "work",
      direction: "inbound",
      messageIdHeader: "<email-1@example.com>",
      referencesHeader: "<root@example.com>",
      threadKey: "<root@example.com>",
      subject: "Question",
      fromAddress: "alice@example.com",
      bodyText: "Can you check this?",
      authSummary: "trusted",
      hasAttachments: false,
      createdAt: 1,
    });
    store.recipients.set("email-1", [
      {id: "r1", messageId: "email-1", role: "to", address: "panda@example.com", createdAt: 1},
      {id: "r2", messageId: "email-1", role: "to", address: "bob@example.com", createdAt: 1},
      {id: "r3", messageId: "email-1", role: "cc", address: "carol@example.com", createdAt: 1},
    ]);
    const context = createContext();
    const tool = new EmailSendTool<DefaultAgentSessionContext>({store});

    await tool.run({
      accountKey: "work",
      replyToEmailId: "email-1",
      replyMode: "all",
      text: "I’ll check it.",
    }, createRunContext(context));

    expect(context.queued).toEqual([expect.objectContaining({
      metadata: {
        email: expect.objectContaining({
          to: [{address: "alice@example.com"}],
          cc: [{address: "bob@example.com"}, {address: "carol@example.com"}],
          subject: "Re: Question",
          inReplyTo: "<email-1@example.com>",
          references: "<root@example.com> <email-1@example.com>",
          threadKey: "<root@example.com>",
        }),
      },
    })]);
  });

  it("blocks non-allowlisted recipients before queueing", async () => {
    const store = new MemoryEmailStore();
    const context = createContext();
    const tool = new EmailSendTool<DefaultAgentSessionContext>({store});

    await expect(tool.run({
      accountKey: "work",
      to: [{address: "mallory@example.com"}],
      subject: "Nope",
      text: "Nope",
    }, createRunContext(context))).rejects.toThrow("not allowed");
    expect(context.queued).toEqual([]);
  });

  it("rejects an unknown email account before queueing", async () => {
    const store = new MemoryEmailStore();
    const context = createContext();
    const tool = new EmailSendTool<DefaultAgentSessionContext>({store});

    await expect(tool.run({
      accountKey: "missing",
      to: [{address: "alice@example.com"}],
      subject: "Nope",
      text: "Nope",
    }, createRunContext(context))).rejects.toThrow("Unknown email account missing");
    expect(context.queued).toEqual([]);
  });

  it("rejects replies to messages from another account", async () => {
    const store = new MemoryEmailStore();
    store.messages.set("email-1", {
      id: "email-1",
      agentKey: "panda",
      accountKey: "personal",
      direction: "inbound",
      threadKey: "<email-1@example.com>",
      subject: "Wrong lane",
      fromAddress: "alice@example.com",
      authSummary: "trusted",
      hasAttachments: false,
      createdAt: 1,
    });
    const context = createContext();
    const tool = new EmailSendTool<DefaultAgentSessionContext>({store});

    await expect(tool.run({
      accountKey: "work",
      replyToEmailId: "email-1",
      text: "Nope",
    }, createRunContext(context))).rejects.toThrow("does not belong to account work");
    expect(context.queued).toEqual([]);
  });

  it("validates attachment paths before queueing", async () => {
    const store = new MemoryEmailStore();
    await store.addAllowedRecipient("panda", "work", "alice@example.com");
    const context = createContext();
    const tool = new EmailSendTool<DefaultAgentSessionContext>({store});

    await expect(tool.run({
      accountKey: "work",
      to: [{address: "alice@example.com"}],
      subject: "Missing file",
      text: "See attachment.",
      attachments: [{path: "__missing_email_attachment__.txt"}],
    }, createRunContext(context))).rejects.toThrow("No readable file found");
    expect(context.queued).toEqual([]);

    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-email-tool-"));
    await expect(tool.run({
      accountKey: "work",
      to: [{address: "alice@example.com"}],
      subject: "Directory",
      text: "See attachment.",
      attachments: [{path: directory}],
    }, createRunContext(context))).rejects.toThrow("is not a file");
    expect(context.queued).toEqual([]);
  });
});
