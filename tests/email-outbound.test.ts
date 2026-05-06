import {describe, expect, it, vi} from "vitest";
import {mkdtemp, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {CredentialResolver} from "../src/domain/credentials/index.js";
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
import {createEmailOutboundAdapter} from "../src/integrations/channels/email/outbound.js";

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
      port: 465,
      secure: true,
      usernameCredentialEnvKey: "SMTP_USER",
      passwordCredentialEnvKey: "SMTP_PASS",
    },
    mailboxes: ["INBOX"],
    syncState: {},
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  allowed = new Set(["alice@example.com"]);
  recorded: RecordEmailMessageInput[] = [];

  async ensureSchema(): Promise<void> {}
  async upsertAccount(_input: UpsertEmailAccountInput): Promise<EmailAccountRecord> {
    return this.account;
  }
  async disableAccount(): Promise<EmailAccountRecord> {
    this.account = {...this.account, enabled: false};
    return this.account;
  }
  async getAccount(): Promise<EmailAccountRecord> {
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
  async recordMessage(input: RecordEmailMessageInput): Promise<RecordEmailMessageResult> {
    this.recorded.push(input);
    const message: EmailMessageRecord = {
      id: "email-outbound-1",
      agentKey: input.agentKey,
      accountKey: input.accountKey,
      direction: input.direction,
      threadKey: input.threadKey ?? "thread",
      authSummary: input.authSummary ?? "trusted",
      hasAttachments: Boolean(input.attachments?.length),
      createdAt: 1,
    };
    return {message, inserted: true};
  }
  async getMessage(): Promise<EmailMessageRecord> {
    throw new Error("unused");
  }
  async listMessageRecipients(): Promise<readonly EmailMessageRecipientRecord[]> {
    return [];
  }
}

function fakeResolver(): CredentialResolver {
  return {
    resolveCredential: async (envKey: string) => ({
      id: envKey,
      envKey,
      value: `${envKey}-value`,
      valuePreview: "preview",
      agentKey: "panda",
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
  } as unknown as CredentialResolver;
}

describe("Email outbound adapter", () => {
  it("sends SMTP mail and records outbound history", async () => {
    const store = new MemoryEmailStore();
    const sendMail = vi.fn(async () => ({messageId: "<sent@example.com>"}));
    const adapter = createEmailOutboundAdapter({
      store,
      credentialResolver: fakeResolver(),
      sendMail,
    });

    const result = await adapter.send({
      deliveryId: "delivery-1",
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [],
          threadKey: "Hello",
        },
      },
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        requireTLS: false,
        user: "SMTP_USER-value",
        pass: "SMTP_PASS-value",
      }),
      message: expect.objectContaining({
        subject: "Hello",
        text: "Hello",
      }),
    }));
    expect(store.recorded).toEqual([expect.objectContaining({
      direction: "outbound",
      messageIdHeader: "<sent@example.com>",
      sourceDeliveryId: "delivery-1",
      recipients: [
        {role: "from", address: "panda@example.com", name: undefined},
        {role: "to", address: "alice@example.com"},
      ],
    })]);
    expect(result.sent).toEqual([{type: "text", externalMessageId: "<sent@example.com>"}]);
  });

  it("requires STARTTLS for SMTP submission on 587", async () => {
    const store = new MemoryEmailStore();
    store.account = {
      ...store.account,
      smtp: {
        ...store.account.smtp,
        port: 587,
        secure: false,
      },
    };
    const sendMail = vi.fn(async () => ({messageId: "<sent@example.com>"}));
    const adapter = createEmailOutboundAdapter({
      store,
      credentialResolver: fakeResolver(),
      sendMail,
    });

    await adapter.send({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [],
          threadKey: "Hello",
        },
      },
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({
        port: 587,
        secure: false,
        requireTLS: true,
      }),
    }));
  });

  it("checks the allowlist again in the adapter", async () => {
    const store = new MemoryEmailStore();
    const adapter = createEmailOutboundAdapter({
      store,
      credentialResolver: fakeResolver(),
      sendMail: async () => ({messageId: "<sent@example.com>"}),
    });

    await expect(adapter.send({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          to: [{address: "mallory@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [],
          threadKey: "Hello",
        },
      },
    })).rejects.toThrow("not allowed");
  });

  it("rejects queued email metadata that spoofs the configured from address", async () => {
    const store = new MemoryEmailStore();
    const sendMail = vi.fn(async () => ({messageId: "<sent@example.com>"}));
    const adapter = createEmailOutboundAdapter({
      store,
      credentialResolver: fakeResolver(),
      sendMail,
    });

    await expect(adapter.send({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "ceo@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [],
          threadKey: "Hello",
        },
      },
    })).rejects.toThrow("from address does not match");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects malformed queued email metadata before SMTP send", async () => {
    const store = new MemoryEmailStore();
    const sendMail = vi.fn(async () => ({messageId: "<sent@example.com>"}));
    const adapter = createEmailOutboundAdapter({
      store,
      credentialResolver: fakeResolver(),
      sendMail,
    });

    await expect(adapter.send({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          to: [{}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [],
          threadKey: "Hello",
        },
      },
    })).rejects.toThrow("metadata is invalid");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("validates queued attachment paths before SMTP send", async () => {
    const store = new MemoryEmailStore();
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-email-outbound-"));
    const attachmentPath = path.join(directory, "brief.txt");
    await writeFile(attachmentPath, "hello");
    const sendMail = vi.fn(async () => ({messageId: "<sent@example.com>"}));
    const adapter = createEmailOutboundAdapter({
      store,
      credentialResolver: fakeResolver(),
      sendMail,
    });

    await adapter.send({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}, {type: "file", path: attachmentPath}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [{path: attachmentPath, filename: "brief.txt"}],
          threadKey: "Hello",
        },
      },
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        attachments: [expect.objectContaining({path: attachmentPath, filename: "brief.txt"})],
      }),
    }));

    await expect(adapter.send({
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [{type: "text", text: "Hello"}],
      metadata: {
        email: {
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [{path: path.join(directory, "missing.txt")}],
          threadKey: "Hello",
        },
      },
    })).rejects.toThrow("No readable file found");
  });
});
