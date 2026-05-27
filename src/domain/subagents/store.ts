import type {
  GetSubagentProfileInput,
  ListSubagentProfilesInput,
  SubagentProfileRecord,
  UpsertSubagentProfileInput,
  SetSubagentProfileEnabledInput,
} from "./types.js";

export interface SubagentProfileStore {
  ensureSchema(): Promise<void>;
  seedBuiltinProfiles(profiles?: readonly UpsertSubagentProfileInput[]): Promise<readonly SubagentProfileRecord[]>;
  upsertProfile(input: UpsertSubagentProfileInput): Promise<SubagentProfileRecord>;
  getProfile(input: GetSubagentProfileInput): Promise<SubagentProfileRecord | null>;
  listProfiles(input?: ListSubagentProfilesInput): Promise<readonly SubagentProfileRecord[]>;
  setProfileEnabled(input: SetSubagentProfileEnabledInput): Promise<SubagentProfileRecord>;
}
