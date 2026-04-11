export type BrowserSessionScope = "thread" | "ephemeral";
export type BrowserProgressStatus =
  | "starting"
  | "connecting"
  | "navigating"
  | "acting"
  | "snapshotting"
  | "capturing"
  | "evaluating"
  | "closing";

export type BrowserLoadState = "load" | "domcontentloaded" | "networkidle";

export type BrowserAction =
  | {
      action: "navigate";
      url: string;
      timeoutMs?: number;
    }
  | {
      action: "snapshot";
    }
  | {
      action: "click";
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    }
  | {
      action: "type";
      ref?: string;
      selector?: string;
      text: string;
      submit?: boolean;
      timeoutMs?: number;
    }
  | {
      action: "press";
      key: string;
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    }
  | {
      action: "select";
      ref?: string;
      selector?: string;
      value?: string;
      values?: string[];
      timeoutMs?: number;
    }
  | {
      action: "wait";
      loadState?: BrowserLoadState;
      selector?: string;
      text?: string;
      url?: string;
      timeoutMs?: number;
    }
  | {
      action: "evaluate";
      script: string;
      arg?: unknown;
      timeoutMs?: number;
    }
  | {
      action: "screenshot";
      ref?: string;
      selector?: string;
      fullPage?: boolean;
      timeoutMs?: number;
    }
  | {
      action: "pdf";
      timeoutMs?: number;
    }
  | {
      action: "close";
    };

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string;
  text: string;
  type?: string;
  disabled?: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: readonly BrowserSnapshotElement[];
}
