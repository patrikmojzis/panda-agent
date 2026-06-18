import type {
  BindingFormValues,
  A2ABindingFormValues,
  BriefingFormValues,
  AgentPairingFormValues,
  ChannelActorPairingFormValues,
  CredentialFormValues,
  ControlGrantFormValues,
  DiscordActorPairingFormValues,
  DiscordConnectorFormValues,
  EmailAllowedRecipientFormValues,
  EmailConnectorFormValues,
  TelegramConnectorFormValues,
  EmailRouteFormValues,
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

function blankToUndefined(value: string) {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function sessionPayload(values: SessionFormValues) {
  return {
    alias: blankToUndefined(values.alias),
    displayName: blankToUndefined(values.displayName),
    kind: blankToUndefined(values.kind),
  }
}

export function sessionLabelPayload(values: SessionFormValues) {
  return {
    alias: blankToUndefined(values.alias) ?? null,
    displayName: blankToUndefined(values.displayName) ?? null,
  }
}

export function runtimeConfigPayload(values: RuntimeConfigFormValues) {
  return {
    model: blankToUndefined(values.model) ?? null,
    thinking: values.thinking,
  }
}

export function briefingPayload(values: BriefingFormValues) {
  return values.content
}

export function heartbeatConfigPayload(values: HeartbeatConfigFormValues) {
  return {
    confirm: "update-heartbeat",
    enabled: values.enabled,
    everyMinutes: Number.parseInt(values.everyMinutes, 10),
  }
}

export function scheduledTaskPayload(values: ScheduledTaskFormValues, mode: "create" | "update") {
  const instruction = blankToUndefined(values.instruction)
  return {
    enabled: values.enabled,
    title: values.title.trim(),
    schedule:
      values.scheduleKind === "once"
        ? { kind: "once", runAt: new Date(values.runAt).toISOString() }
        : { kind: "recurring", cron: values.cron.trim(), timezone: values.timezone.trim() },
    ...(mode === "create" || instruction ? { instruction } : {}),
  }
}

export function watchConfigPayload(values: WatchConfigFormValues) {
  return {
    enabled: values.enabled,
    intervalMinutes: Number.parseInt(values.intervalMinutes, 10),
    title: values.title.trim(),
  }
}

export function credentialPayload(values: CredentialFormValues) {
  return {
    envKey: values.envKey.trim(),
    value: values.value,
  }
}

export function wikiBindingPayload(values: WikiBindingFormValues) {
  return {
    apiToken: values.apiToken,
    namespacePath: values.namespacePath.trim(),
    wikiGroupId: Number.parseInt(values.wikiGroupId, 10),
  }
}

export function controlGrantPayload(values: ControlGrantFormValues) {
  return {
    identityId: values.identityId,
    label: blankToUndefined(values.label),
    role: values.role,
    ...(values.role === "scoped" ? { agentKey: values.agentKey } : {}),
  }
}

export function discordConnectorPayload(values: DiscordConnectorFormValues) {
  return {
    accountKey: values.accountKey.trim(),
    botToken: blankToUndefined(values.botToken),
    connectorKey: values.connectorKey.trim(),
    displayName: blankToUndefined(values.displayName),
    source: "discord",
  }
}

export function telegramConnectorPayload(values: TelegramConnectorFormValues) {
  return {
    accountKey: values.accountKey.trim(),
    botToken: values.botToken,
    replace: values.replace,
    source: "telegram",
  }
}

export function emailConnectorPayload(values: EmailConnectorFormValues) {
  return {
    accountKey: values.accountKey.trim(),
    displayName: blankToUndefined(values.displayName),
    fromAddress: values.fromAddress.trim(),
    fromName: blankToUndefined(values.fromName),
    imapHost: values.imapHost.trim(),
    imapPassword: blankToUndefined(values.imapPassword),
    imapPort: blankToUndefined(values.imapPort),
    imapSecure: values.imapSecure,
    imapUsername: blankToUndefined(values.imapUsername),
    mailboxes: values.mailboxes
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
    smtpHost: values.smtpHost.trim(),
    smtpPassword: blankToUndefined(values.smtpPassword),
    smtpPort: blankToUndefined(values.smtpPort),
    smtpSecure: values.smtpSecure,
    smtpUsername: blankToUndefined(values.smtpUsername),
    source: "email",
  }
}

export function bindingPayload(values: BindingFormValues) {
  return {
    connectorKey: values.connectorKey.trim(),
    displayName: blankToUndefined(values.displayName),
    externalConversationId: values.externalConversationId.trim(),
    sessionId: values.sessionId.trim(),
    source: values.source.trim(),
  }
}

export function a2aBindingPayload(values: A2ABindingFormValues) {
  return {
    oneWay: values.oneWay,
    recipientSessionId: values.recipientSessionId.trim(),
  }
}

export function emailRoutePayload(values: EmailRouteFormValues) {
  return {
    accountKey: values.accountKey.trim(),
    mailbox: blankToUndefined(values.mailbox),
    sessionId: values.sessionId.trim(),
  }
}

export function emailAllowedRecipientPayload(values: EmailAllowedRecipientFormValues) {
  return {
    accountKey: values.accountKey.trim(),
    address: values.address.trim(),
  }
}

export function discordActorPairingPayload(values: DiscordActorPairingFormValues) {
  return {
    accountKey: values.accountKey.trim(),
    externalActorId: values.externalActorId.trim(),
    identityId: values.identityId.trim(),
  }
}

export function channelActorPairingPayload(values: ChannelActorPairingFormValues) {
  return {
    connectorKey: values.connectorKey.trim(),
    externalActorId: values.externalActorId.trim(),
    identityId: values.identityId.trim(),
    source: values.source,
  }
}

export function agentPairingPayload(values: AgentPairingFormValues) {
  return {
    identityId: values.identityId.trim(),
  }
}

export function identityCreatePayload(values: IdentityFormValues) {
  return {
    displayName: blankToUndefined(values.displayName),
    handle: values.handle.trim(),
  }
}

export function identityUpdatePayload(values: IdentityFormValues) {
  return {
    displayName: values.displayName.trim(),
    status: values.status,
  }
}

export function skillPayload(values: SkillFormValues) {
  return {
    content: values.content,
    description: values.description.trim(),
    skillKey: values.skillKey.trim(),
    tags: values.tags
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    agentEditable: values.agentEditable,
  }
}

export function subagentPayload(values: SubagentFormValues) {
  return {
    description: values.description.trim(),
    model: blankToUndefined(values.model),
    prompt: values.prompt,
    slug: values.slug.trim(),
    thinking: blankToUndefined(values.thinking),
    toolGroups: values.toolGroups.map((value) => value.trim()).filter(Boolean),
  }
}
