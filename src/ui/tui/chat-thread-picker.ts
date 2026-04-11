import type {ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {ThreadPickerState} from "./chat-shared.js";
import {resolveThreadPickerSelection} from "./chat-session.js";
import type {NoticeState} from "./chat-view.js";
import type {ChatRuntimeServices} from "./runtime.js";
import {clamp} from "./screen.js";

type NoticeTone = NoticeState["tone"];

export interface ChatThreadPickerHost {
  threadPicker: ThreadPickerState;
  getCurrentThreadId(): string;
  isRunning(): boolean;
  requireServices(): ChatRuntimeServices;
  switchThread(thread: ThreadRecord): Promise<void>;
  render(): void;
  setNotice(text: string, tone: NoticeTone, durationMs?: number): void;
  getRefreshInFlight(): boolean;
  setRefreshInFlight(enabled: boolean): void;
  getRefreshRequested(): boolean;
  setRefreshRequested(enabled: boolean): void;
}

// Keep thread-picker orchestration out of chat.ts so the shell only owns local state.
export async function refreshChatThreadPicker(host: ChatThreadPickerHost): Promise<void> {
  if (host.getRefreshInFlight()) {
    host.setRefreshRequested(true);
    return;
  }

  host.setRefreshInFlight(true);
  const selectedThreadId =
    host.threadPicker.summaries[host.threadPicker.selected]?.thread.id ?? host.getCurrentThreadId();
  host.threadPicker.loading = true;
  host.threadPicker.error = null;
  host.render();

  try {
    const summaries = await host.requireServices().listThreadSummaries(16);
    host.threadPicker.summaries = summaries;
    host.threadPicker.selected = resolveThreadPickerSelection({
      summaries,
      selectedThreadId,
      currentThreadId: host.getCurrentThreadId(),
    });
  } catch (error) {
    host.threadPicker.error = error instanceof Error ? error.message : String(error);
    host.threadPicker.summaries = [];
    host.threadPicker.selected = 0;
  } finally {
    host.threadPicker.loading = false;
    host.setRefreshInFlight(false);
    if (host.threadPicker.active && host.getRefreshRequested()) {
      host.setRefreshRequested(false);
      queueMicrotask(() => {
        void refreshChatThreadPicker(host);
      });
    }
  }
}

export async function openChatThreadPicker(host: ChatThreadPickerHost): Promise<void> {
  if (host.isRunning()) {
    host.setNotice("Abort or wait for the current run before switching threads.", "info");
    return;
  }

  host.threadPicker.active = true;
  host.threadPicker.selected = 0;
  await refreshChatThreadPicker(host);
  host.render();
}

export function closeChatThreadPicker(
  threadPicker: ThreadPickerState,
  setRefreshRequested: (enabled: boolean) => void,
): void {
  threadPicker.active = false;
  threadPicker.loading = false;
  threadPicker.error = null;
  threadPicker.summaries = [];
  threadPicker.selected = 0;
  setRefreshRequested(false);
}

export function cycleChatThreadPicker(
  threadPicker: ThreadPickerState,
  delta: number,
): void {
  if (threadPicker.summaries.length === 0) {
    return;
  }

  threadPicker.selected = clamp(
    threadPicker.selected + delta,
    0,
    threadPicker.summaries.length - 1,
  );
}

export async function selectChatThreadPickerEntry(host: ChatThreadPickerHost): Promise<void> {
  if (host.threadPicker.loading) {
    return;
  }

  const summary = host.threadPicker.summaries[host.threadPicker.selected];
  if (!summary) {
    closeChatThreadPicker(host.threadPicker, (enabled) => host.setRefreshRequested(enabled));
    return;
  }

  await host.switchThread(summary.thread);
  closeChatThreadPicker(host.threadPicker, (enabled) => host.setRefreshRequested(enabled));
  host.setNotice(`Resumed thread ${host.getCurrentThreadId()}.`, "info");
}
