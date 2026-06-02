import { create } from "zustand"

import type { A2ABindingRow, BindingRow, Briefing, ConnectorRow, CredentialRow, EmailRouteRow, Heartbeat, IdentityOptionRow, ScheduledTask, SessionDetail, SessionRow, SkillRow, SubagentRow, WatchRow, WikiBinding } from "@/lib/api"
import type { FormCreateSheetState, FormUpdateSheetState } from "@/types/entity-form-sheet-types"

export type AgentSheetContext = {
  agentKey: string
  sessionId?: string
  sourceId?: string
}

export type SessionFormValues = {
  displayName: string
  alias: string
  kind: string
}

export type RuntimeConfigFormValues = {
  model: string
  thinking: string
}

export type BriefingFormValues = {
  content: string
}

export type HeartbeatConfigFormValues = {
  enabled: boolean
  everyMinutes: string
}

export type ScheduledTaskFormValues = {
  title: string
  instruction: string
  scheduleKind: "once" | "recurring"
  runAt: string
  cron: string
  timezone: string
  enabled: boolean
}

export type WatchConfigFormValues = {
  title: string
  intervalMinutes: string
  enabled: boolean
}

export type CredentialFormValues = {
  envKey: string
  value: string
}

export type WikiBindingFormValues = {
  wikiGroupId: string
  namespacePath: string
  apiToken: string
}

export type DiscordConnectorFormValues = {
  accountKey: string
  connectorKey: string
  displayName: string
  botToken: string
}

export type EmailConnectorFormValues = {
  accountKey: string
  displayName: string
  fromAddress: string
  fromName: string
  mailboxes: string
  imapHost: string
  imapPort: string
  imapSecure: string
  imapUsername: string
  imapPassword: string
  smtpHost: string
  smtpPort: string
  smtpSecure: string
  smtpUsername: string
  smtpPassword: string
}

export type BindingFormValues = {
  source: string
  connectorKey: string
  externalConversationId: string
  sessionId: string
  displayName: string
}

export type A2ABindingFormValues = {
  recipientSessionId: string
  oneWay: boolean
}

export type EmailRouteFormValues = {
  accountKey: string
  mailbox: string
  sessionId: string
}

export type EmailAllowedRecipientFormValues = {
  accountKey: string
  address: string
}

export type DiscordActorPairingFormValues = {
  accountKey: string
  externalActorId: string
  identityId: string
}

export type ChannelActorPairingFormValues = {
  source: "telegram" | "whatsapp"
  connectorKey: string
  externalActorId: string
  identityId: string
}

export type AgentPairingFormValues = {
  identityId: string
}

export type IdentityFormValues = {
  handle: string
  displayName: string
  status: "active" | "deleted"
}

export type ControlGrantFormValues = {
  identityId: string
  role: "admin" | "scoped"
  agentKey: string
  label: string
}

export type SkillFormValues = {
  skillKey: string
  description: string
  content: string
}

export type SubagentFormValues = {
  slug: string
  description: string
  toolGroups: string[]
  prompt: string
  model: string
  thinking: string
}

function createFormSheetStore<TForm>() {
  return create<FormCreateSheetState<TForm, AgentSheetContext>>((set) => ({
    isOpen: false,
    setOpen: (isOpen, options) =>
      set({
        context: isOpen ? options?.context : undefined,
        defaultData: isOpen ? options?.defaultData : undefined,
        isOpen,
      }),
  }))
}

function createUpdateFormSheetStore<TEntity, TForm>() {
  return create<FormUpdateSheetState<TEntity, TForm, AgentSheetContext>>((set) => ({
    isOpen: false,
    setOpen: (isOpen, options) =>
      set({
        context: isOpen ? options?.context : undefined,
        defaultData: isOpen ? options?.defaultData : undefined,
        entity: isOpen ? options?.entity : undefined,
        isOpen,
      }),
  }))
}

export const useCreateSessionSheet = createFormSheetStore<SessionFormValues>()
export const useUpdateSessionSheet = createUpdateFormSheetStore<SessionRow, SessionFormValues>()
export const useRuntimeConfigSheet = createUpdateFormSheetStore<SessionDetail, RuntimeConfigFormValues>()
export const useBriefingSheet = createUpdateFormSheetStore<Briefing, BriefingFormValues>()
export const useHeartbeatConfigSheet = createUpdateFormSheetStore<Heartbeat, HeartbeatConfigFormValues>()
export const useScheduledTaskSheet = createUpdateFormSheetStore<ScheduledTask, ScheduledTaskFormValues>()
export const useWatchConfigSheet = createUpdateFormSheetStore<WatchRow, WatchConfigFormValues>()
export const useCredentialSheet = createUpdateFormSheetStore<CredentialRow, CredentialFormValues>()
export const useWikiBindingSheet = createUpdateFormSheetStore<WikiBinding, WikiBindingFormValues>()
export const useDiscordConnectorSheet = createUpdateFormSheetStore<ConnectorRow, DiscordConnectorFormValues>()
export const useEmailConnectorSheet = createUpdateFormSheetStore<ConnectorRow, EmailConnectorFormValues>()
export const useBindingSheet = createUpdateFormSheetStore<BindingRow, BindingFormValues>()
export const useA2ABindingSheet = createUpdateFormSheetStore<A2ABindingRow, A2ABindingFormValues>()
export const useEmailRouteSheet = createUpdateFormSheetStore<EmailRouteRow, EmailRouteFormValues>()
export const useEmailAllowedRecipientSheet = createFormSheetStore<EmailAllowedRecipientFormValues>()
export const useDiscordActorPairingSheet = createFormSheetStore<DiscordActorPairingFormValues>()
export const useChannelActorPairingSheet = createFormSheetStore<ChannelActorPairingFormValues>()
export const useAgentPairingSheet = createFormSheetStore<AgentPairingFormValues>()
export const useIdentitySheet = createUpdateFormSheetStore<IdentityOptionRow, IdentityFormValues>()
export const useControlGrantSheet = createFormSheetStore<ControlGrantFormValues>()
export const useSkillSheet = createUpdateFormSheetStore<SkillRow, SkillFormValues>()
export const useSubagentSheet = createUpdateFormSheetStore<SubagentRow, SubagentFormValues>()
