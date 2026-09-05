import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import type {CommandWritableFileResolver} from "../src/domain/commands/files.js";
import type {CommandRequest, RegisteredCommand} from "../src/domain/commands/types.js";
import {createEmailAttachmentsFetchCommand} from "../src/domain/email/commands.js";
import type {EmailAttachmentRecord, EmailMessageRecord} from "../src/domain/email/types.js";
import {createTelegramMediaFetchCommand} from "../src/integrations/channels/telegram/commands.js";

const scope = {agentKey: "panda", sessionId: "session-a", threadId: "thread-a"};
const refusal = "Refusing to overwrite existing file at saved/report.txt; pass --overwrite to replace it.";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

function createEmailCommand(sourcePath: string, files: CommandWritableFileResolver): RegisteredCommand {
  const message: EmailMessageRecord = {
    id: "message-a", agentKey: scope.agentKey, accountKey: "work", sessionId: scope.sessionId,
    direction: "inbound", threadKey: "thread-a", authSummary: "unknown", hasAttachments: true, createdAt: 1,
  };
  const attachment: EmailAttachmentRecord = {
    id: "media-a", messageId: message.id, filename: "report.txt", localPath: sourcePath,
    mimeType: "text/plain", storageStatus: "stored", createdAt: 1,
  };
  return createEmailAttachmentsFetchCommand({store: {
    getMessage: async () => message,
    getMessageAttachment: async () => attachment,
    assertMessageOwnedBySession: async () => {},
    listMessageAttachments: async () => [attachment],
    listMessageRecipients: async () => [],
    listMessagesForSession: async () => [message],
    searchMessagesForSession: async () => [message],
  }}, files);
}

function createTelegramCommand(sourcePath: string, files: CommandWritableFileResolver): RegisteredCommand {
  return createTelegramMediaFetchCommand({
    connectorAccounts: {listAccounts: async () => [{
      id: "connector-a", source: "telegram", connectorKey: "connector-a", accountKey: "main",
      ownerKind: "agent", ownerAgentKey: scope.agentKey, ownerIdentityId: null,
      status: "enabled", config: {}, createdAt: 1, updatedAt: 1,
    }]},
    conversations: {getConversationBinding: async () => ({
      source: "telegram", connectorKey: "connector-a", externalConversationId: "12345",
      sessionId: scope.sessionId, createdAt: 1, updatedAt: 1,
    })},
    messages: {findChannelMedia: async () => ({
      message: {
        id: "message-a", threadId: scope.threadId, sequence: 1, origin: "input", source: "telegram",
        message: {role: "user", content: "Report", timestamp: 1}, createdAt: 1,
      },
      media: {
        id: "media-a", source: "telegram", connectorKey: "connector-a", mimeType: "text/plain",
        sizeBytes: 8, localPath: sourcePath, originalFilename: "report.txt", createdAt: 1,
      },
    })},
  }, files);
}

describe.each([
  {name: "email.attachments.fetch", create: createEmailCommand, input: {attachmentId: "media-a"}},
  {name: "telegram.media.fetch", create: createTelegramCommand, input: {mediaId: "media-a", conversationId: "12345", connectorKey: "connector-a"}},
])("$name destination ownership", ({name, create, input}) => {
  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "panda-attachment-copy-"));
    directories.push(root);
    const sourcePath = path.join(root, "source.txt");
    const targetPath = path.join(root, "saved", "report.txt");
    await writeFile(sourcePath, "report-a");
    const request: CommandRequest = {
      command: name, scope, workingDirectory: root, input: {...input, save: "saved/report.txt"},
    };
    const files = new RuntimeCommandFileResolver({BASH_EXECUTION_MODE: "local"});
    return {root, sourcePath, targetPath, request, files};
  }

  it("preserves an existing destination unless overwrite is explicitly enabled", async () => {
    const {sourcePath, targetPath, request, files} = await fixture();
    await mkdir(path.dirname(targetPath));
    await writeFile(targetPath, "keep-me");
    const command = create(sourcePath, files);

    await expect(command.execute(request)).rejects.toThrow(refusal);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("keep-me");

    await command.execute({...request, input: {...input, save: "saved/report.txt", overwrite: true}});
    await expect(readFile(targetPath, "utf8")).resolves.toBe("report-a");
  });

  it("allows exactly one concurrent save to own a new destination", async () => {
    const {root, sourcePath, targetPath, request, files} = await fixture();
    const secondSource = path.join(root, "second.txt");
    await writeFile(secondSource, "report-b");
    const ready = Promise.withResolvers<void>();
    let waiting = 0;
    const concurrentFiles: CommandWritableFileResolver = {
      async resolveWritablePath(value) {
        const resolved = await files.resolveWritablePath(value);
        if (++waiting === 2) ready.resolve();
        await ready.promise;
        return resolved;
      },
    };

    const results = await Promise.allSettled([
      create(sourcePath, concurrentFiles).execute(request),
      create(secondSource, concurrentFiles).execute(request),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({reason: {message: refusal}});
    const winningContent = results[0]!.status === "fulfilled" ? "report-a" : "report-b";
    await expect(readFile(targetPath, "utf8")).resolves.toBe(winningContent);
  });

  it("preserves filesystem errors when the source disappears before copying", async () => {
    const {sourcePath, request, files} = await fixture();
    const disappearingSource: CommandWritableFileResolver = {
      async resolveWritablePath(value) {
        const resolved = await files.resolveWritablePath(value);
        await rm(sourcePath);
        return resolved;
      },
    };

    await expect(create(sourcePath, disappearingSource).execute(request)).rejects.toMatchObject({code: "ENOENT"});
  });
});
