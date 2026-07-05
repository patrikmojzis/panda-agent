import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import {
  createEmailAccountListCommand,
  createEmailAttachmentsFetchCommand,
  createEmailSendCommand,
  EMAIL_ACCOUNT_LIST_COMMAND_NAME,
  EMAIL_ATTACHMENTS_FETCH_COMMAND_NAME,
  EMAIL_SEND_COMMAND_NAME,
  type EmailAccountListCommandStore,
  type EmailReadCommandStore,
  type EmailSendCommandStore,
} from "../src/domain/email/commands.js";
import type {
  EmailAccountRecord,
  EmailAttachmentRecord,
  EmailMessageRecipientRecord,
  EmailMessageRecord,
  EmailRouteRecord,
} from "../src/domain/email/types.js";

function createEnvironmentMetadata(root: string) {
  return {
    filesystem: {
      envDir: "worker-a",
      root: {
        corePath: root,
        parentRunnerPath: "/environments/worker-a",
      },
      workspace: {
        corePath: path.join(root, "workspace"),
        parentRunnerPath: "/environments/worker-a/workspace",
        workerPath: "/workspace",
      },
      inbox: {
        corePath: path.join(root, "inbox"),
        parentRunnerPath: "/environments/worker-a/inbox",
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: path.join(root, "artifacts"),
        parentRunnerPath: "/environments/worker-a/artifacts",
        workerPath: "/artifacts",
      },
    },
  };
}

function createAccount(): EmailAccountRecord {
  return {
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
}

describe("email.send command", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("lists current-agent email accounts without exposing endpoint credentials", async () => {
    const accounts: EmailAccountRecord[] = [
      createAccount(),
      {
        ...createAccount(),
        agentKey: "koala",
        accountKey: "koala-work",
        fromAddress: "koala@example.com",
      },
      {
        ...createAccount(),
        accountKey: "personal",
        fromAddress: "panda-personal@example.com",
      },
    ];
    const routes: EmailRouteRecord[] = [
      {
        id: "route-work",
        agentKey: "panda",
        accountKey: "work",
        sessionId: "session-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "route-personal",
        agentKey: "panda",
        accountKey: "personal",
        sessionId: "session-other",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const store: EmailAccountListCommandStore = {
      listEnabledAccounts: vi.fn(async () => accounts),
      listRoutes: vi.fn(async () => routes),
      assertAccountSendableBySession: vi.fn(async (input) => {
        if (input.accountKey !== "work") {
          throw new Error("not routed");
        }
      }),
    };
    const command = createEmailAccountListCommand({store});

    const result = await command.execute({
      command: EMAIL_ACCOUNT_LIST_COMMAND_NAME,
      input: {},
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
      },
    });

    expect(result.output).toEqual({
      ok: true,
      count: 2,
      accounts: [
        {
          accountKey: "work",
          fromAddress: "panda@example.com",
          mailboxes: ["INBOX"],
          sendable: true,
          currentSessionRoutes: [{scope: "account"}],
          updatedAt: 1,
        },
        {
          accountKey: "personal",
          fromAddress: "panda-personal@example.com",
          mailboxes: ["INBOX"],
          sendable: false,
          sendBlockedReason: "account_routed_elsewhere",
          updatedAt: 1,
        },
      ],
    });
    expect(JSON.stringify(result.output)).not.toContain("imap.example.com");
    expect(JSON.stringify(result.output)).not.toContain("IMAP_PASS");
  });

  it("filters email account list to sendable accounts", async () => {
    const store: EmailAccountListCommandStore = {
      listEnabledAccounts: vi.fn(async () => [
        createAccount(),
        {
          ...createAccount(),
          accountKey: "personal",
          fromAddress: "panda-personal@example.com",
        },
      ]),
      listRoutes: vi.fn(async (): Promise<readonly EmailRouteRecord[]> => []),
      assertAccountSendableBySession: vi.fn(async (input) => {
        if (input.accountKey !== "work") {
          throw new Error("not routed");
        }
      }),
    };
    const command = createEmailAccountListCommand({store});

    const result = await command.execute({
      command: EMAIL_ACCOUNT_LIST_COMMAND_NAME,
      input: {
        sendableOnly: true,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
      },
    });

    expect(result.output).toMatchObject({
      ok: true,
      count: 1,
      accounts: [
        {
          accountKey: "work",
          sendable: true,
        },
      ],
    });
  });

  it("resolves workspace attachments before queueing email delivery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panda-email-send-command-"));
    directories.add(root);
    const workspaceNested = path.join(root, "workspace", "nested");
    const reportPath = path.join(workspaceNested, "report.txt");
    await mkdir(workspaceNested, {recursive: true});
    await writeFile(reportPath, "hello", "utf8");
    const resolvedReportPath = await realpath(reportPath);

    const store: EmailSendCommandStore = {
      getAccount: vi.fn(async () => createAccount()),
      assertAccountSendableBySession: vi.fn(async () => {}),
      assertMessageOwnedBySession: vi.fn(async () => {}),
      getMessage: vi.fn(async (): Promise<EmailMessageRecord> => {
        throw new Error("not used");
      }),
      listMessageRecipients: vi.fn(async (): Promise<readonly EmailMessageRecipientRecord[]> => []),
      assertRecipientsAllowed: vi.fn(async () => {}),
    };
    const enqueueDelivery = vi.fn(async (input) => ({
      id: "delivery-1",
      channel: input.channel,
    }));
    const command = createEmailSendCommand({
      store,
      queue: {
        enqueueDelivery,
      },
    }, new RuntimeCommandFileResolver());

    const result = await command.execute({
      command: EMAIL_SEND_COMMAND_NAME,
      input: {
        accountKey: "work",
        to: [{address: "alice@example.com"}],
        subject: "Report",
        text: "Attached.",
        attachments: [{path: "report.txt", filename: "report.txt"}],
      },
      workingDirectory: "/workspace/nested",
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
        executionEnvironment: {
          id: "worker:session-a",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: createEnvironmentMetadata(root),
        },
      },
    });

    expect(store.assertAccountSendableBySession).toHaveBeenCalledWith({
      agentKey: "panda",
      accountKey: "work",
      sessionId: "session-a",
    });
    expect(store.assertRecipientsAllowed).toHaveBeenCalledWith("panda", "work", ["alice@example.com"]);
    expect(enqueueDelivery).toHaveBeenCalledWith({
      threadId: "thread-a",
      channel: "email",
      target: {
        source: "email",
        connectorKey: "smtp",
        externalConversationId: "work",
      },
      items: [
        {type: "text", text: "Attached."},
        {type: "file", path: resolvedReportPath, filename: "report.txt"},
      ],
      metadata: {
        email: expect.objectContaining({
          kind: "email_send",
          agentKey: "panda",
          accountKey: "work",
          sessionId: "session-a",
          fromAddress: "panda@example.com",
          to: [{address: "alice@example.com"}],
          cc: [],
          subject: "Report",
          text: "Attached.",
          attachments: [{path: resolvedReportPath, filename: "report.txt"}],
          threadKey: "Report",
        }),
      },
    });
    expect(result.output).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      channel: "email",
      accountKey: "work",
      from: "panda@example.com",
    });
  });
});

describe("email.attachments.fetch command", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("copies a session-visible attachment into the workspace and returns a view artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panda-email-attachment-command-"));
    directories.add(root);
    await mkdir(path.join(root, "workspace"), {recursive: true});
    const sourcePath = path.join(root, "source-invoice.pdf");
    await writeFile(sourcePath, "invoice-pdf", "utf8");

    const message: EmailMessageRecord = {
      id: "message-1",
      agentKey: "panda",
      accountKey: "work",
      sessionId: "session-a",
      direction: "inbound",
      threadKey: "thread-1",
      subject: "Invoice",
      fromAddress: "alice@example.com",
      authSummary: "trusted",
      hasAttachments: true,
      createdAt: 1,
    };
    const attachment: EmailAttachmentRecord = {
      id: "attachment-1",
      messageId: message.id,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
      localPath: sourcePath,
      createdAt: 1,
    };
    const store: EmailReadCommandStore = {
      getMessage: vi.fn(async () => message),
      assertMessageOwnedBySession: vi.fn(async () => {}),
      getMessageAttachment: vi.fn(async () => attachment),
      listMessageAttachments: vi.fn(async () => [attachment]),
      listMessageRecipients: vi.fn(async (): Promise<readonly EmailMessageRecipientRecord[]> => []),
      listMessagesForSession: vi.fn(async () => [message]),
      searchMessagesForSession: vi.fn(async () => [message]),
    };
    const command = createEmailAttachmentsFetchCommand({
      store,
    }, new RuntimeCommandFileResolver());

    const result = await command.execute({
      command: EMAIL_ATTACHMENTS_FETCH_COMMAND_NAME,
      input: {
        attachmentId: attachment.id,
        save: "./invoice.pdf",
      },
      workingDirectory: "/workspace",
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
        executionEnvironment: {
          id: "worker:session-a",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: createEnvironmentMetadata(root),
        },
      },
    });

    const savedPath = path.join(root, "workspace", "invoice.pdf");
    await expect(readFile(savedPath, "utf8")).resolves.toBe("invoice-pdf");
    const resolvedSavedPath = await realpath(savedPath);
    expect(store.assertMessageOwnedBySession).toHaveBeenCalledWith({
      messageId: message.id,
      sessionId: "session-a",
    });
    expect(result.output).toMatchObject({
      ok: true,
      attachment: {
        id: "attachment-1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        messageId: "message-1",
      },
      saved: {
        path: resolvedSavedPath,
        displayPath: "./invoice.pdf",
        bytes: 11,
        mimeType: "application/pdf",
      },
    });
    expect(result.artifact).toMatchObject({
      kind: "pdf",
      source: "view_media",
      path: resolvedSavedPath,
      mimeType: "application/pdf",
      bytes: 11,
    });
  });
});
