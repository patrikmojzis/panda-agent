import {describe, expect, it, vi} from "vitest";
import {mkdtemp, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
    EmailAccountRecord,
    EmailMessageRecord,
    RecordEmailMessageInput,
    RecordEmailMessageResult,
} from "../src/domain/email/types.js";
import {normalizeEmailAddress} from "../src/domain/email/shared.js";
import {
  createEmailOutboundAdapter,
  type CreateEmailOutboundAdapterOptions,
} from "../src/integrations/channels/email/outbound.js";

type EmailOutboundStore = CreateEmailOutboundAdapterOptions["store"];
type EmailOutboundCredentialResolver = CreateEmailOutboundAdapterOptions["credentialResolver"];

class MemoryEmailStore implements EmailOutboundStore {
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
  accountSendable = true;
  messageOwned = true;
  messages = new Map<string, EmailMessageRecord>();
  recorded: RecordEmailMessageInput[] = [];

  async getAccount(): Promise<EmailAccountRecord> {
    return this.account;
  }

  async assertRecipientsAllowed(_agentKey: string, accountKey: string, addresses: readonly string[]): Promise<void> {
    const blocked = addresses
      .map((address) => normalizeEmailAddress(address))
      .filter((address) => !this.allowed.has(address));
    if (blocked.length > 0) {
      throw new Error(`Email account ${accountKey} is not allowed to send to ${blocked.join(", ")}.`);
    }
  }
  async assertAccountSendableBySession(): Promise<void> {
    if (!this.accountSendable) {
      throw new Error("Email account work is not routed to session session-1.");
    }
  }
  async assertMessageOwnedBySession(): Promise<void> {
    if (!this.messageOwned) {
      throw new Error("Email message email-1 is not visible to session session-1.");
    }
  }
  async getMessage(messageId: string): Promise<EmailMessageRecord> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Unknown email message ${messageId}`);
    }

    return message;
  }
  async recordMessage(input: RecordEmailMessageInput): Promise<RecordEmailMessageResult> {
    this.recorded.push(input);
    const message: EmailMessageRecord = {
      id: "email-outbound-1",
      agentKey: input.agentKey,
      accountKey: input.accountKey,
      sessionId: input.sessionId,
      direction: input.direction,
      threadKey: input.threadKey ?? "thread",
      authSummary: input.authSummary ?? "trusted",
      hasAttachments: Boolean(input.attachments?.length),
      createdAt: 1,
    };
    return {message, inserted: true};
  }
}

function fakeResolver(): EmailOutboundCredentialResolver {
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
  };
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
          sessionId: "session-1",
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
      sessionId: "session-1",
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
          sessionId: "session-1",
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

  it("checks account ownership again in the adapter", async () => {
    const store = new MemoryEmailStore();
    store.accountSendable = false;
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
          sessionId: "session-1",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Hello",
          text: "Hello",
          attachments: [],
          threadKey: "Hello",
        },
      },
    })).rejects.toThrow("not routed to session");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("checks reply message ownership account in the adapter", async () => {
    const store = new MemoryEmailStore();
    store.messages.set("email-1", {
      id: "email-1",
      agentKey: "panda",
      accountKey: "personal",
      direction: "inbound",
      threadKey: "thread",
      authSummary: "trusted",
      hasAttachments: false,
      createdAt: 1,
    });
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
          sessionId: "session-1",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Re: Hello",
          text: "Hello",
          attachments: [],
          replyToEmailId: "email-1",
          threadKey: "thread",
        },
      },
    })).rejects.toThrow("does not belong to account work");
    expect(sendMail).not.toHaveBeenCalled();
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
          sessionId: "session-1",
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
          sessionId: "session-1",
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
          sessionId: "session-1",
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
          sessionId: "session-1",
          fromAddress: "panda@example.com",
          fromName: 42,
          to: [{address: "alice@example.com"}],
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
          sessionId: "session-1",
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
          sessionId: "session-1",
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
