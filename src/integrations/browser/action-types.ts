export type BrowserSessionScope = "session" | "thread" | "ephemeral";
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
export type BrowserSnapshotMode = "compact" | "full";
export type BrowserDeviceProfile = "desktop" | "desktop-wide" | "mobile-compact" | "mobile" | "tablet";
export type BrowserPageSignal = "dialog" | "alert" | "validation_error" | "login" | "captcha";
export type BrowserPageSection = "page" | "dialog";

type BrowserSnapshotActionOptions = {
  snapshotMode?: BrowserSnapshotMode;
  deviceProfile?: BrowserDeviceProfile;
  timeoutMs?: number;
};

type BrowserDeviceActionOptions = {
  deviceProfile?: BrowserDeviceProfile;
};

export type BrowserAction =
  | ({
      action: "navigate";
      url: string;
    } & BrowserSnapshotActionOptions)
  | ({
      action: "snapshot";
    } & BrowserSnapshotActionOptions)
  | ({
      action: "click";
      ref?: string;
      selector?: string;
    } & BrowserSnapshotActionOptions)
  | ({
      action: "type";
      ref?: string;
      selector?: string;
      text: string;
      submit?: boolean;
    } & BrowserSnapshotActionOptions)
  | ({
      action: "press";
      key: string;
      ref?: string;
      selector?: string;
    } & BrowserSnapshotActionOptions)
  | ({
      action: "select";
      ref?: string;
      selector?: string;
      value?: string;
      values?: string[];
    } & BrowserSnapshotActionOptions)
  | ({
      action: "wait";
      loadState?: BrowserLoadState;
      selector?: string;
      text?: string;
      url?: string;
    } & BrowserSnapshotActionOptions)
  | {
      action: "evaluate";
      script: string;
      arg?: unknown;
      timeoutMs?: number;
    } & BrowserDeviceActionOptions
  | {
      action: "screenshot";
      ref?: string;
      selector?: string;
      fullPage?: boolean;
      labels?: boolean;
      timeoutMs?: number;
    } & BrowserDeviceActionOptions
  | {
      action: "pdf";
      timeoutMs?: number;
    } & BrowserDeviceActionOptions
  | {
      action: "close";
    } & BrowserDeviceActionOptions;

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string;
  text: string;
  type?: string;
  disabled?: boolean;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  required?: boolean;
  invalid?: boolean;
  readonly?: boolean;
  href?: string;
  section?: BrowserPageSection;
}

export interface BrowserSnapshotChangeTarget {
  ref?: string;
  selector?: string;
  before?: string;
  after?: string;
  changed?: readonly string[];
}

export interface BrowserSnapshotChanges {
  pageSwitched?: boolean;
  urlChanged?: {
    before: string;
    after: string;
  };
  titleChanged?: {
    before?: string;
    after?: string;
  };
  dialogAppeared?: boolean;
  dialogDismissed?: boolean;
  signalsAdded?: readonly BrowserPageSignal[];
  signalsRemoved?: readonly BrowserPageSignal[];
  target?: BrowserSnapshotChangeTarget;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  pageText: string;
  dialogText: string;
  signals: readonly BrowserPageSignal[];
  elements: readonly BrowserSnapshotElement[];
}
