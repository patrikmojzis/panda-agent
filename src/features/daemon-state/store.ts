import type {PandaDaemonStateRecord} from "./types.js";

export interface PandaDaemonStateStore {
  ensureSchema(): Promise<void>;
  heartbeat(daemonKey: string): Promise<PandaDaemonStateRecord>;
  readState(daemonKey: string): Promise<PandaDaemonStateRecord | null>;
}
