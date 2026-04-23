import type {RegisterTelepathyDeviceInput, TelepathyDeviceRecord} from "./types.js";

export interface TelepathyDeviceStore {
  ensureSchema(): Promise<void>;
  clearConnectedStates(): Promise<void>;
  registerDevice(input: RegisterTelepathyDeviceInput): Promise<TelepathyDeviceRecord>;
  getDevice(agentKey: string, deviceId: string): Promise<TelepathyDeviceRecord>;
  listDevices(agentKey: string): Promise<readonly TelepathyDeviceRecord[]>;
  setDeviceEnabled(agentKey: string, deviceId: string, enabled: boolean): Promise<TelepathyDeviceRecord>;
  markConnected(agentKey: string, deviceId: string, label?: string): Promise<TelepathyDeviceRecord>;
  touchLastSeen(agentKey: string, deviceId: string): Promise<void>;
  markDisconnected(agentKey: string, deviceId: string): Promise<void>;
}
