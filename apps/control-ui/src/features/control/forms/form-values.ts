import type { Briefing, ConnectorRow, EmailRouteRow, Heartbeat, IdentityOptionRow, ScheduledTask, SessionDetail, SessionRow, SkillRow, SubagentRow, WatchRow, WikiBinding } from "@/lib/api"
import type {
  BindingFormValues,
  A2ABindingFormValues,
  BriefingFormValues,
  AgentPairingFormValues,
  ChannelActorPairingFormValues,
  CredentialFormValues,
  ControlGrantFormValues,
  DiscordConnectorFormValues,
  DiscordActorPairingFormValues,
  EmailAllowedRecipientFormValues,
  EmailRouteFormValues,
  EmailConnectorFormValues,
  TelegramConnectorFormValues,
  HeartbeatConfigFormValues,
  IdentityFormValues,
  RuntimeConfigFormValues,
  ScheduledTaskFormValues,
  SessionFormValues,
  SkillFormValues,
  SubagentFormValues,
  WatchConfigFormValues,
  WikiBindingFormValues,
} from "@/features/control/forms/use-control-form-sheets"

export const sessionDefaults: SessionFormValues = {
  alias: "",
  displayName: "",
  kind: "branch",
}

export const runtimeConfigDefaults: RuntimeConfigFormValues = {
  model: "",
  thinking: "default",
}

export const briefingDefaults: BriefingFormValues = {
  content: "",
}

export const heartbeatConfigDefaults: HeartbeatConfigFormValues = {
  enabled: false,
  everyMinutes: "60",
}

export function scheduledTaskDefaults(): ScheduledTaskFormValues {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000)
  return {
    cron: "0 9 * * *",
    enabled: true,
    instruction: "",
    runAt: toDatetimeLocal(nextHour.toISOString()),
    scheduleKind: "once",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    title: "",
  }
}

export const watchConfigDefaults: WatchConfigFormValues = {
  enabled: true,
  intervalMinutes: "15",
  title: "",
}

export const credentialDefaults: CredentialFormValues = {
  envKey: "",
  value: "",
}

export const wikiBindingDefaults: WikiBindingFormValues = {
  apiToken: "",
  namespacePath: "",
  wikiGroupId: "",
}

export const controlGrantDefaults: ControlGrantFormValues = {
  agentKey: "",
  identityId: "",
  label: "",
  role: "scoped",
}

export const discordConnectorDefaults: DiscordConnectorFormValues = {
  accountKey: "",
  botToken: "",
  connectorKey: "",
  displayName: "",
}

export const telegramConnectorDefaults: TelegramConnectorFormValues = {
  accountKey: "",
  botToken: "",
  replace: false,
}

export const emailConnectorDefaults: EmailConnectorFormValues = {
  accountKey: "",
  displayName: "",
  fromAddress: "",
  fromName: "",
  imapHost: "",
  imapPassword: "",
  imapPort: "",
  imapSecure: "default",
  imapUsername: "",
  mailboxes: "INBOX",
  smtpHost: "",
  smtpPassword: "",
  smtpPort: "",
  smtpSecure: "default",
  smtpUsername: "",
}

export const bindingDefaults: BindingFormValues = {
  connectorKey: "",
  displayName: "",
  externalConversationId: "",
  sessionId: "",
  source: "discord",
}

export const a2aBindingDefaults: A2ABindingFormValues = {
  oneWay: false,
  recipientSessionId: "",
}

export const emailRouteDefaults: EmailRouteFormValues = {
  accountKey: "",
  mailbox: "",
  sessionId: "",
}

export const emailAllowedRecipientDefaults: EmailAllowedRecipientFormValues = {
  accountKey: "",
  address: "",
}

export const discordActorPairingDefaults: DiscordActorPairingFormValues = {
  accountKey: "",
  externalActorId: "",
  identityId: "",
}

export const channelActorPairingDefaults: ChannelActorPairingFormValues = {
  connectorKey: "",
  externalActorId: "",
  identityId: "",
  source: "telegram",
}

export const agentPairingDefaults: AgentPairingFormValues = {
  identityId: "",
}

export const identityDefaults: IdentityFormValues = {
  displayName: "",
  handle: "",
  status: "active",
}

export const skillDefaults: SkillFormValues = {
  content: "",
  description: "",
  skillKey: "",
  tags: "",
}

export const subagentDefaults: SubagentFormValues = {
  description: "",
  model: "",
  prompt: "",
  slug: "",
  thinking: "",
  toolGroups: ["core"],
}

export function sessionToFormValues(session: SessionRow): SessionFormValues {
  return {
    alias: session.alias ?? "",
    displayName: session.displayName ?? "",
    kind: session.kind,
  }
}

export function runtimeConfigToFormValues(session: SessionDetail): RuntimeConfigFormValues {
  return {
    model: session.runtime.model ?? "",
    thinking: session.runtime.thinking ?? (session.runtime.thinkingConfigured ? "off" : "default"),
  }
}

export function briefingToFormValues(briefing: Briefing): BriefingFormValues {
  return {
    content: briefing.content ?? "",
  }
}

export function heartbeatConfigToFormValues(heartbeat: Heartbeat): HeartbeatConfigFormValues {
  return {
    enabled: heartbeat.enabled,
    everyMinutes: String(heartbeat.everyMinutes),
  }
}

export function scheduledTaskToFormValues(task: ScheduledTask): ScheduledTaskFormValues {
  const defaults = scheduledTaskDefaults()
  if (task.schedule.kind === "once") {
    return {
      ...defaults,
      enabled: task.enabled,
      instruction: "",
      runAt: toDatetimeLocal(task.schedule.runAt),
      scheduleKind: "once",
      title: task.title,
    }
  }

  return {
    ...defaults,
    cron: task.schedule.cron,
    enabled: task.enabled,
    instruction: "",
    scheduleKind: "recurring",
    timezone: task.schedule.timezone,
    title: task.title,
  }
}

export function watchConfigToFormValues(watch: WatchRow): WatchConfigFormValues {
  return {
    enabled: watch.enabled,
    intervalMinutes: String(watch.intervalMinutes),
    title: watch.title,
  }
}

export function connectorToDiscordFormValues(connector: ConnectorRow): DiscordConnectorFormValues {
  return {
    accountKey: connector.accountKey,
    botToken: "",
    connectorKey: connector.connectorKey,
    displayName: connector.displayName ?? "",
  }
}

function secureMode(value: boolean | undefined) {
  if (value === true) return "secure"
  if (value === false) return "starttls"
  return "default"
}

export function connectorToEmailFormValues(connector: ConnectorRow): EmailConnectorFormValues {
  const email = connector.email
  return {
    accountKey: connector.accountKey,
    displayName: connector.displayName ?? "",
    fromAddress: email?.fromAddress ?? connector.externalUsername ?? "",
    fromName: email?.fromName ?? "",
    imapHost: email?.imap.host ?? "",
    imapPassword: "",
    imapPort: email?.imap.port?.toString() ?? "",
    imapSecure: secureMode(email?.imap.secure),
    imapUsername: "",
    mailboxes: email?.mailboxes.join(", ") ?? "INBOX",
    smtpHost: email?.smtp.host ?? "",
    smtpPassword: "",
    smtpPort: email?.smtp.port?.toString() ?? "",
    smtpSecure: secureMode(email?.smtp.secure),
    smtpUsername: "",
  }
}

export function wikiBindingToFormValues(binding: WikiBinding): WikiBindingFormValues {
  return {
    apiToken: "",
    namespacePath: binding.namespacePath,
    wikiGroupId: String(binding.wikiGroupId),
  }
}

export function identityToFormValues(identity: IdentityOptionRow): IdentityFormValues {
  return {
    displayName: identity.displayName,
    handle: identity.handle,
    status: identity.status === "deleted" ? "deleted" : "active",
  }
}

export function emailRouteToFormValues(route: EmailRouteRow): EmailRouteFormValues {
  return {
    accountKey: route.accountKey,
    mailbox: route.mailbox ?? "",
    sessionId: route.sessionId,
  }
}

export function skillToFormValues(skill: SkillRow): SkillFormValues {
  return {
    content: skill.content ?? "",
    description: skill.description ?? "",
    skillKey: skill.skillKey,
    tags: skill.tags?.join(", ") ?? "",
  }
}

export function subagentToFormValues(subagent: SubagentRow): SubagentFormValues {
  return {
    description: subagent.description ?? "",
    model: subagent.model ?? "",
    prompt: subagent.prompt ?? "",
    slug: subagent.slug,
    thinking: subagent.thinking ?? "",
    toolGroups: subagent.toolGroups.length > 0 ? subagent.toolGroups : ["core"],
  }
}

function toDatetimeLocal(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
