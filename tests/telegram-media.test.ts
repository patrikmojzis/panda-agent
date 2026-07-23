import {afterEach, describe, expect, it, vi} from "vitest";

import {
  collectTelegramMediaParts,
  downloadTelegramSupportedMedia,
} from "../src/integrations/channels/telegram/media.js";

describe("telegram media", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects supported media parts with MIME defaults and metadata", () => {
    expect(collectTelegramMediaParts({
      message_id: 1,
      chat: {
        id: 777,
        type: "private",
      },
      photo: [
        {
          file_id: "small-photo",
          file_unique_id: "small-photo-uniq",
          width: 100,
          height: 100,
          file_size: 3,
        },
        {
          file_id: "large-photo",
          file_unique_id: "large-photo-uniq",
          width: 800,
          height: 600,
          file_size: 5,
        },
      ],
      document: {
        file_id: "legacy-document",
        file_unique_id: "legacy-document-uniq",
        file_name: "fun.gif",
        mime_type: "image/gif",
        file_size: 5,
      },
      animation: {
        file_id: "animation-file",
        file_unique_id: "animation-file-uniq",
        file_name: "fun.gif",
        file_size: 5,
        duration: 2,
        width: 320,
        height: 240,
      },
      sticker: {
        file_id: "video-sticker",
        file_unique_id: "video-sticker-uniq",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: true,
        file_size: 5,
        emoji: "🙂",
        set_name: "panda",
      },
      audio: {
        file_id: "audio-file",
        file_unique_id: "audio-file-uniq",
        file_name: "song.mp3",
        duration: 180,
        title: "Song",
        performer: "Band",
        file_size: 5,
      },
      video_note: {
        file_id: "video-note-file",
        file_unique_id: "video-note-uniq",
        duration: 4,
        length: 240,
        file_size: 5,
      },
    })).toEqual([
      {
        kind: "photo",
        fileId: "large-photo",
        fileUniqueId: "large-photo-uniq",
        mimeType: "image/jpeg",
        sizeBytes: 5,
        metadata: {
          telegramMediaKind: "photo",
          width: 800,
          height: 600,
        },
      },
      {
        kind: "sticker",
        fileId: "video-sticker",
        fileUniqueId: "video-sticker-uniq",
        mimeType: "video/webm",
        sizeBytes: 5,
        metadata: {
          telegramMediaKind: "sticker",
          emoji: "🙂",
          setName: "panda",
          stickerType: "regular",
          stickerFormat: "video",
          isAnimated: false,
          isVideo: true,
          width: 512,
          height: 512,
        },
      },
      {
        kind: "audio",
        fileId: "audio-file",
        fileUniqueId: "audio-file-uniq",
        mimeType: "audio/mpeg",
        sizeBytes: 5,
        hintFilename: "song.mp3",
        metadata: {
          telegramMediaKind: "audio",
          duration: 180,
          title: "Song",
          performer: "Band",
        },
      },
      {
        kind: "animation",
        fileId: "animation-file",
        fileUniqueId: "animation-file-uniq",
        mimeType: "image/gif",
        sizeBytes: 5,
        hintFilename: "fun.gif",
        metadata: {
          telegramMediaKind: "animation",
          duration: 2,
          width: 320,
          height: 240,
        },
      },
      {
        kind: "video_note",
        fileId: "video-note-file",
        fileUniqueId: "video-note-uniq",
        mimeType: "video/mp4",
        sizeBytes: 5,
        metadata: {
          telegramMediaKind: "video_note",
          duration: 4,
          length: 240,
        },
      },
    ]);
  });

  it("downloads media through the media store with Telegram file metadata", async () => {
    const api = {
      getFile: vi.fn(async () => ({
        file_path: "videos/file.mp4",
      })),
    };
    const mediaStore = {
      writeMedia: vi.fn(async (input) => ({
        id: "media-1",
        source: "telegram",
        connectorKey: input.connectorKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        localPath: "/tmp/media.bin",
        metadata: input.metadata,
        createdAt: 1,
      })),
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from("media"),
    } as Response));

    await expect(downloadTelegramSupportedMedia({
      message_id: 1,
      chat: {
        id: 777,
        type: "private",
      },
      video: {
        file_id: "video-file",
        file_unique_id: "video-file-uniq",
        file_size: 5,
        duration: 8,
        width: 640,
        height: 360,
      },
    }, {
      api,
      token: "telegram-token",
      connectorKey: "42",
      mediaStore,
      fetchImpl,
    })).resolves.toEqual({
      media: [expect.objectContaining({
        id: "media-1",
        mimeType: "video/mp4",
        sizeBytes: 5,
      })],
      unavailable: [],
    });
    expect(api.getFile).toHaveBeenCalledWith("video-file");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.telegram.org/file/bottelegram-token/videos/file.mp4", expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      connectorKey: "42",
      mimeType: "video/mp4",
      sizeBytes: 5,
      metadata: {
        telegramFileId: "video-file",
        telegramFileUniqueId: "video-file-uniq",
        telegramFilePath: "videos/file.mp4",
        telegramMediaKind: "video",
        duration: 8,
        width: 640,
        height: 360,
      },
    }));
  });

  it("marks oversized media unavailable without fetching Telegram file metadata", async () => {
    const api = {
      getFile: vi.fn(),
    };
    const unavailable: unknown[] = [];

    await expect(downloadTelegramSupportedMedia({
      message_id: 1,
      chat: {
        id: 777,
        type: "private",
      },
      document: {
        file_id: "big-file",
        file_unique_id: "big-file-uniq",
        file_name: "archive.zip",
        mime_type: "application/zip",
        file_size: 35 * 1024 * 1024,
      },
    }, {
      api,
      token: "telegram-token",
      connectorKey: "42",
      mediaStore: {
        writeMedia: vi.fn(),
      },
      onUnavailable: (item) => {
        unavailable.push(item);
      },
    })).resolves.toEqual({
      media: [],
      unavailable: [{
        kind: "document",
        mimeType: "application/zip",
        sizeBytes: 35 * 1024 * 1024,
        filename: "archive.zip",
        reason: "Telegram Bot API only exposes bot-downloadable files up to 20 MB.",
      }],
    });
    expect(api.getFile).not.toHaveBeenCalled();
    expect(unavailable).toHaveLength(1);
  });

  it("aborts stalled Telegram file downloads", async () => {
    vi.useFakeTimers();
    const abortError = Object.assign(new Error("aborted"), {name: "AbortError"});
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(abortError);
      }, {once: true});
    }));
    const handled = downloadTelegramSupportedMedia({
      message_id: 1,
      chat: {
        id: 777,
        type: "private",
      },
      video: {
        file_id: "slow-video",
        file_unique_id: "slow-video-uniq",
        file_size: 5,
        duration: 2,
        width: 320,
        height: 240,
      },
    }, {
      api: {
        getFile: vi.fn(async () => ({
          file_path: "videos/slow.mp4",
        })),
      },
      token: "telegram-token",
      connectorKey: "42",
      mediaStore: {
        writeMedia: vi.fn(),
      },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const expectation = expect(handled).rejects.toThrow("Telegram file slow-video download timed out after 30000ms.");

    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });
});
