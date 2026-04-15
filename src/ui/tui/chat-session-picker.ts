import type {ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {SessionPickerState} from "./chat-shared.js";
import {resolveSessionPickerSelection} from "./chat-session.js";
import type {NoticeState} from "./chat-view.js";
import type {ChatRuntimeServices} from "./runtime.js";
import {clamp} from "./screen.js";

type NoticeTone = NoticeState["tone"];

export interface ChatSessionPickerHost {
  sessionPicker: SessionPickerState;
  getCurrentSessionId(): string;
  getCurrentAgentKey(): string;
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

// Keep session-picker orchestration out of chat.ts so the shell only owns local state.
export async function refreshChatSessionPicker(host: ChatSessionPickerHost): Promise<void> {
  if (host.getRefreshInFlight()) {
    host.setRefreshRequested(true);
    return;
  }

  host.setRefreshInFlight(true);
  const selectedSessionId =
    host.sessionPicker.sessions[host.sessionPicker.selected]?.id ?? host.getCurrentSessionId();
  host.sessionPicker.loading = true;
  host.sessionPicker.error = null;
  host.render();

  try {
    const sessions = await host.requireServices().listAgentSessions(host.getCurrentAgentKey());
    host.sessionPicker.sessions = sessions;
    host.sessionPicker.selected = resolveSessionPickerSelection({
      sessions,
      selectedSessionId,
      currentSessionId: host.getCurrentSessionId(),
    });
  } catch (error) {
    host.sessionPicker.error = error instanceof Error ? error.message : String(error);
    host.sessionPicker.sessions = [];
    host.sessionPicker.selected = 0;
  } finally {
    host.sessionPicker.loading = false;
    host.setRefreshInFlight(false);
    if (host.sessionPicker.active && host.getRefreshRequested()) {
      host.setRefreshRequested(false);
      queueMicrotask(() => {
        void refreshChatSessionPicker(host);
      });
    }
  }
}

export async function openChatSessionPicker(host: ChatSessionPickerHost): Promise<void> {
  if (host.isRunning()) {
    host.setNotice("Abort or wait for the current run before switching sessions.", "info");
    return;
  }

  host.sessionPicker.active = true;
  host.sessionPicker.selected = 0;
  await refreshChatSessionPicker(host);
  host.render();
}

export function closeChatSessionPicker(
  sessionPicker: SessionPickerState,
  setRefreshRequested: (enabled: boolean) => void,
): void {
  sessionPicker.active = false;
  sessionPicker.loading = false;
  sessionPicker.error = null;
  sessionPicker.sessions = [];
  sessionPicker.selected = 0;
  setRefreshRequested(false);
}

export function cycleChatSessionPicker(
  sessionPicker: SessionPickerState,
  delta: number,
): void {
  if (sessionPicker.sessions.length === 0) {
    return;
  }

  sessionPicker.selected = clamp(
    sessionPicker.selected + delta,
    0,
    sessionPicker.sessions.length - 1,
  );
}

export async function selectChatSessionPickerEntry(host: ChatSessionPickerHost): Promise<void> {
  if (host.sessionPicker.loading) {
    return;
  }

  const session = host.sessionPicker.sessions[host.sessionPicker.selected];
  if (!session) {
    closeChatSessionPicker(host.sessionPicker, (enabled) => host.setRefreshRequested(enabled));
    return;
  }

  try {
    await host.switchThread(await host.requireServices().openSession(session.id));
  } catch {
    host.setNotice(`Session ${session.id} is no longer available. Refreshed the list.`, "error");
    await refreshChatSessionPicker(host);
    host.render();
    return;
  }

  closeChatSessionPicker(host.sessionPicker, (enabled) => host.setRefreshRequested(enabled));
  host.setNotice(`Opened session ${session.id}.`, "info");
}
