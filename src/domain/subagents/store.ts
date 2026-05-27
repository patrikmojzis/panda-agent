import type {
  GetSubagentProfileInput,
  ListSubagentProfilesInput,
  SubagentProfileRecord,
  UpsertSubagentProfileInput,
} from "./types.js";

export interface SubagentProfileStore {
  ensureSchema(): Promise<void>;
  seedBuiltinProfiles(profiles?: readonly UpsertSubagentProfileInput[]): Promise<readonly SubagentProfileRecord[]>;
  upsertProfile(input: UpsertSubagentProfileInput): Promise<SubagentProfileRecord>;
  getProfile(input: GetSubagentProfileInput): Promise<SubagentProfileRecord | null>;
  listProfiles(input?: ListSubagentProfilesInput): Promise<readonly SubagentProfileRecord[]>;
}
