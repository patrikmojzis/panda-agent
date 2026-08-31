import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  agentCacheKey,
  mergedValues,
  requireContext,
  useInvalidateAgent,
} from "@/features/control/forms/form-sheet-shared"
import {
  bindingDefaults,
  channelActorPairingDefaults,
  connectorToDiscordFormValues,
  connectorToEmailFormValues,
  discordActorPairingDefaults,
  discordConnectorDefaults,
  emailRecipientAllowRuleDefaults,
  emailConnectorDefaults,
  telegramConnectorDefaults,
  whatsappConnectorDefaults,
  emailRouteDefaults,
  emailRouteToFormValues,
} from "@/features/control/forms/form-values"
import {
  bindingPayload,
  channelActorPairingPayload,
  discordActorPairingPayload,
  discordConnectorPayload,
  emailRecipientAllowRulePayload,
  emailConnectorPayload,
  telegramConnectorPayload,
  whatsappConnectorPayload,
  emailRoutePayload,
} from "@/features/control/forms/form-payloads"
import {
  useBindingSheet,
  useChannelActorPairingSheet,
  useDiscordActorPairingSheet,
  useDiscordConnectorSheet,
  useEmailRecipientAllowRuleSheet,
  useEmailConnectorSheet,
  useTelegramConnectorSheet,
  useWhatsAppConnectorSheet,
  useEmailRouteSheet,
  type BindingFormValues,
  type ChannelActorPairingFormValues,
  type DiscordActorPairingFormValues,
  type DiscordConnectorFormValues,
  type EmailRecipientAllowRuleFormValues,
  type EmailConnectorFormValues,
  type TelegramConnectorFormValues,
  type WhatsAppConnectorFormValues,
  type EmailRouteFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import {
  useConnectorOptions,
  useDiscordAccountOptions,
  useEmailAccountOptions,
  useSessionOptions,
} from "@/features/control/forms/form-options"
import { useAgentPairings } from "@/features/control/api/queries"
import {
  displayWhatsAppState,
  isActiveWhatsAppAttempt,
  isExactWhatsAppActorJid,
  resolveWhatsAppManagementActions,
  resolveWhatsAppSetupStage,
} from "@/features/control/agent/whatsapp-setup-model"
import {
  controlApi,
  type WhatsAppLinkAttempt,
  type WhatsAppSetupStatus,
} from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { handleControlFormError } from "@/lib/form-errors"

function useAgentPairedIdentityOptions(
  agentKey: string | undefined,
  isOpen: boolean,
  selectedIdentityId?: string
) {
  const pairings = useAgentPairings(
    agentKey ?? "",
    {
      page: 1,
      per_page: 100,
      sort_by: "identityHandle",
      sort_direction: "asc",
    },
    { enabled: isOpen && Boolean(agentKey), staleTime: 30_000 }
  )

  const options = React.useMemo(() => {
    const baseOptions = (pairings.data?.data ?? []).map((pairing) => ({
      label: `${pairing.identityHandle}${pairing.identityDisplayName ? ` · ${pairing.identityDisplayName}` : ""}`,
      value: pairing.identityId,
    }))
    if (
      selectedIdentityId &&
      !baseOptions.some((option) => option.value === selectedIdentityId)
    ) {
      return [
        {
          label: `Selected identity · ${selectedIdentityId}`,
          value: selectedIdentityId,
        },
        ...baseOptions,
      ]
    }
    return baseOptions
  }, [pairings.data?.data, selectedIdentityId])

  return {
    isLoading: pairings.isLoading,
    options,
  }
}

function discordConnectorSchema(requireBotToken: boolean) {
  return z.object({
    accountKey: z.string().trim().min(1, "Account key is required."),
    botToken: requireBotToken
      ? z
          .string()
          .trim()
          .min(1, "Bot token is required when creating a Discord account.")
      : z.string(),
    connectorKey: z.string().trim().min(1, "Connector key is required."),
    displayName: z.string(),
  })
}

const optionalPortSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (!value) return true
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
  }, "Port must be between 1 and 65535.")

const telegramConnectorSchema = z.object({
  accountKey: z.string().trim().min(1, "Account key is required."),
  botToken: z.string().trim().min(1, "Bot token is required."),
  replace: z.boolean(),
})

const whatsappConnectorSchema = z.object({
  accountKey: z.string().trim().min(1, "Account key is required."),
  displayName: z.string(),
  phone: z.string().refine((value) => {
    const length = value.replace(/[^\d]/g, "").length
    return length >= 8 && length <= 15
  }, "Phone number must contain 8-15 digits."),
})

function emailConnectorSchema(requireSecrets: boolean) {
  const secretSchema = requireSecrets
    ? z.string().trim().min(1, "Required when creating an email account.")
    : z.string()
  return z.object({
    accountKey: z.string().trim().min(1, "Account key is required."),
    displayName: z.string(),
    fromAddress: z.string().trim().email("Enter a valid from address."),
    fromName: z.string(),
    imapHost: z.string().trim().min(1, "IMAP host is required."),
    imapPassword: secretSchema,
    imapPort: optionalPortSchema,
    imapSecure: z.enum(["default", "secure", "starttls"]),
    imapUsername: secretSchema,
    mailboxes: z.string().trim().min(1, "At least one mailbox is required."),
    smtpHost: z.string().trim().min(1, "SMTP host is required."),
    smtpPassword: secretSchema,
    smtpPort: optionalPortSchema,
    smtpSecure: z.enum(["default", "secure", "starttls"]),
    smtpUsername: secretSchema,
  })
}

const bindingSchema = z.object({
  connectorKey: z.string().trim().min(1, "Connector key is required."),
  displayName: z.string(),
  externalConversationId: z
    .string()
    .trim()
    .min(1, "External conversation id is required."),
  sessionId: z.string().trim().min(1, "Session is required."),
  source: z.string().trim().min(1, "Source is required."),
})

const emailRouteSchema = z.object({
  accountKey: z.string().trim().min(1, "Email account is required."),
  mailbox: z.string(),
  sessionId: z.string().trim().min(1, "Session is required."),
})

const emailAccountKeySchema = z
  .string()
  .trim()
  .min(1, "Email account is required.")

const emailRecipientDomainSchema = z
  .string()
  .trim()
  .min(1, "Recipient domain is required.")
  .refine((value) => {
    if (
      value.length > 253 ||
      value.startsWith(".") ||
      value.endsWith(".") ||
      /[@*\/\\:#?\[\]\s]/u.test(value)
    ) {
      return false
    }
    let ascii: string
    try {
      ascii = new URL(`http://${value}`).hostname.toLowerCase()
    } catch {
      return false
    }
    const labels = ascii.split(".")
    return (
      ascii.length <= 253 &&
      labels.length >= 2 &&
      !/^\d+(?:\.\d+)+$/.test(ascii) &&
      labels.every(
        (label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
      )
    )
  }, "Enter a bare domain such as company.com.")

const emailRecipientAllowRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    accountKey: emailAccountKeySchema,
    kind: z.literal("address"),
    value: z.string().trim().email("Enter a valid recipient address."),
  }),
  z.object({
    accountKey: emailAccountKeySchema,
    kind: z.literal("domain"),
    value: emailRecipientDomainSchema,
  }),
])

const discordActorPairingSchema = z.object({
  accountKey: z.string().trim().min(1, "Discord account is required."),
  externalActorId: z
    .string()
    .trim()
    .regex(
      /^\d{1,20}$/,
      "Use the numeric Discord user id/snowflake, not a username."
    )
    .refine((value) => /[1-9]/.test(value), "Discord user id cannot be zero."),
  identityId: z.string().trim().min(1, "Identity is required."),
})

const channelActorPairingSchema = z
  .object({
    connectorKey: z.string().trim().min(1, "Connector key is required."),
    externalActorId: z.string().trim().min(1, "Actor is required."),
    identityId: z.string().trim().min(1, "Identity is required."),
    source: z.enum(["telegram", "whatsapp"]),
  })
  .superRefine((value, context) => {
    if (
      value.source === "telegram" &&
      (!/^\d+$/.test(value.externalActorId) ||
        !/[1-9]/.test(value.externalActorId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Telegram actor id must be a positive numeric user id.",
        path: ["externalActorId"],
      })
    }
    if (value.source === "whatsapp") {
      if (!isExactWhatsAppActorJid(value.externalActorId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Paste the exact observed @lid or @s.whatsapp.net actor JID.",
          path: ["externalActorId"],
        })
      }
    }
  })

const bindingSourceOptions = [
  { label: "Discord", value: "discord" },
  { label: "Email", value: "email" },
  { label: "Telegram", value: "telegram" },
  { label: "WhatsApp", value: "whatsapp" },
]

const channelActorSourceOptions = [
  { label: "Telegram", value: "telegram" },
  { label: "WhatsApp", value: "whatsapp" },
]

const secureModeOptions = [
  { label: "Default", value: "default" },
  { label: "TLS", value: "secure" },
  { label: "STARTTLS / plain", value: "starttls" },
]

const discordConnectorErrorFields = {
  "discord account key": "accountKey",
  "discord connector key": "connectorKey",
  "bot token": "botToken",
  "unsupported control connector source": "accountKey",
}

const telegramConnectorErrorFields = {
  "telegram account key": "accountKey",
  "telegram bot token": "botToken",
  "bot token": "botToken",
}

const whatsappConnectorErrorFields = {
  "whatsapp account key": "accountKey",
  "whatsapp phone number": "phone",
  "phone number": "phone",
}

const emailConnectorErrorFields = {
  "email account key": "accountKey",
  "from address": "fromAddress",
  "imap host": "imapHost",
  "imap port": "imapPort",
  "smtp host": "smtpHost",
  "smtp port": "smtpPort",
  "email secure mode": ["imapSecure", "smtpSecure"],
  "email username and password": [
    "imapUsername",
    "imapPassword",
    "smtpUsername",
    "smtpPassword",
  ],
}

const bindingErrorFields = {
  "binding source": "source",
  "binding connector key": "connectorKey",
  "external conversation id": "externalConversationId",
  "binding session id": "sessionId",
  "connector account": "connectorKey",
  "target session": "sessionId",
}

const emailRouteErrorFields = {
  "email route account key": "accountKey",
  "email account": "accountKey",
  "route session id": "sessionId",
  "target session": "sessionId",
}

const emailRecipientAllowRuleErrorFields = {
  "email allowlist account key": "accountKey",
  "email account": "accountKey",
  "email allowlist rule kind": "kind",
  "email recipient allow rule kind": "kind",
  "email allowlist rule value": "value",
  "email address": "value",
  "email domain": "value",
}

const emailRecipientAllowRuleKindOptions = [
  { label: "Exact address", value: "address" },
  { label: "Entire domain", value: "domain" },
]

const discordActorPairingErrorFields = {
  "discord account key": "accountKey",
  "discord account": "accountKey",
  "discord actor": "externalActorId",
  "discord actor id": "externalActorId",
  identity: "identityId",
  "connector account": "accountKey",
}

const channelActorPairingErrorFields = {
  "channel actor pairing source": "source",
  "telegram connector key": "connectorKey",
  "whatsapp connector key": "connectorKey",
  "telegram actor id": "externalActorId",
  "whatsapp actor": "externalActorId",
  identity: "identityId",
  "target agent": "identityId",
}

export function DiscordConnectorSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useDiscordConnectorSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        discordConnectorDefaults,
        defaultData ??
          (entity ? connectorToDiscordFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: DiscordConnectorFormValues) => {
      const current = requireContext(context)
      return controlApi.upsertConnector(
        current.agentKey,
        discordConnectorPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Discord connector saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: discordConnectorSchema(!entity) },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: discordConnectorErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Update Discord account" : "Save Discord account",
        description: entity
          ? "This updates Discord connector metadata. Entering a bot token rotates the stored token."
          : "This stores Discord connector metadata and a write-only bot token for this agent.",
        confirmLabel: "Save account",
      }}
      description={
        entity
          ? "Bot token is optional on update. Stored tokens stay write-only."
          : "Create a Discord connector account with a write-only bot token."
      }
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Save account"
      title={entity ? "Edit Discord account" : "Discord account"}
    >
      <form.AppField name="accountKey">
        {(field) => (
          <field.TextField
            label="Account key"
            autoComplete="off"
            autoFocus
            disabled={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="connectorKey">
        {(field) => (
          <field.TextField label="Connector key" autoComplete="off" required />
        )}
      </form.AppField>
      <form.AppField name="displayName">
        {(field) => <field.TextField label="Display name" />}
      </form.AppField>
      <form.AppField name="botToken">
        {(field) => (
          <field.TextField
            label="Bot token"
            autoComplete="new-password"
            description={
              entity
                ? "Leave blank to keep the stored token. Enter a new token to rotate it."
                : "Stored write-only and never shown again."
            }
            type="password"
            required={!entity}
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function TelegramConnectorSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useTelegramConnectorSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(telegramConnectorDefaults, defaultData),
    [defaultData]
  )
  const mutation = useMutation({
    mutationFn: (values: TelegramConnectorFormValues) => {
      const current = requireContext(context)
      return controlApi.upsertConnector(
        current.agentKey,
        telegramConnectorPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Telegram connector saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: telegramConnectorSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: telegramConnectorErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Replace Telegram account" : "Save Telegram account",
        description:
          "The bot token is validated with Telegram and stored write-only. Reusing an account key replaces that bot only when Replace is on.",
        confirmLabel: "Save Telegram account",
      }}
      description="Store a Telegram bot token for this agent. Account keys are per bot: use the prefilled agent-specific key when available (main for Clawd, luna for Luna) — not one shared main for every bot."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Save account"
      title="Telegram setup"
    >
      <form.AppField name="accountKey">
        {(field) => (
          <field.TextField
            label="Account key"
            autoComplete="off"
            autoFocus
            description="Per bot key. Keep the prefilled suggestion for this agent unless you are adding another bot. Example: main for Clawd, luna for Luna. Reusing a key needs Replace."
            placeholder="agent-specific key"
            required
          />
        )}
      </form.AppField>
      <form.AppField name="botToken">
        {(field) => (
          <field.TextField
            label="Bot token"
            autoComplete="new-password"
            description="Write-only. Control validates with Telegram getMe and never shows the token again."
            type="password"
            required
          />
        )}
      </form.AppField>
      <form.AppField name="replace">
        {(field) => (
          <field.SwitchField
            label="Replace existing account key"
            description="Leave off to prevent accidental Luna/Clawd overwrites. Turn on only when rotating this exact bot account."
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function WhatsAppConnectorSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useWhatsAppConnectorSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        mergedValues(
          whatsappConnectorDefaults,
          entity
            ? {
                accountKey: entity.accountKey,
                displayName: entity.displayName ?? "",
                phone: "",
              }
            : undefined
        ),
        defaultData
      ),
    [defaultData, entity]
  )
  const [attempt, setAttempt] = React.useState<WhatsAppLinkAttempt | null>(null)
  const [setupStatus, setSetupStatus] =
    React.useState<WhatsAppSetupStatus | null>(null)
  const [createdAccountKey, setCreatedAccountKey] = React.useState<
    string | null
  >(null)
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [attemptPollError, setAttemptPollError] = React.useState<string | null>(
    null
  )
  const [managementError, setManagementError] = React.useState<string | null>(
    null
  )
  const [pollGeneration, setPollGeneration] = React.useState(0)
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false)
  const managedAccountKey = entity?.accountKey ?? createdAccountKey

  const applySetupStatus = React.useCallback((status: WhatsAppSetupStatus) => {
    setSetupStatus(status)
    setStatusError(null)
    setAttempt((current) => {
      if (status.activeAttempt) return status.activeAttempt
      if (!current || !isActiveWhatsAppAttempt(current.state)) return current
      if (status.account.linked) {
        return {
          ...current,
          state: "linked",
          pairingCode: undefined,
          providerAccountId: status.account.providerAccountId,
          updatedAt: Date.now(),
        }
      }
      if (status.account.status === "error") return null
      if (Date.now() >= current.expiresAt) {
        return {
          ...current,
          state: "expired",
          pairingCode: undefined,
          updatedAt: Date.now(),
        }
      }
      return current
    })
  }, [])

  const refreshSetupStatus = React.useCallback(
    async (accountKey: string) => {
      if (!context) return
      const { status } = await controlApi.whatsappSetupStatus(
        context.agentKey,
        accountKey
      )
      applySetupStatus(status)
    },
    [applySetupStatus, context]
  )

  function setWhatsAppSheetOpen(open: boolean) {
    if (!open) {
      setAttempt(null)
      setSetupStatus(null)
      setCreatedAccountKey(null)
      setStatusError(null)
      setAttemptPollError(null)
      setManagementError(null)
      setResetDialogOpen(false)
    }
    setOpen(open)
  }

  React.useEffect(() => {
    if (!isOpen || !context || !managedAccountKey) return
    let cancelled = false
    const refresh = () => {
      void controlApi
        .whatsappSetupStatus(context.agentKey, managedAccountKey)
        .then(({ status }) => {
          if (!cancelled) applySetupStatus(status)
        })
        .catch((error) => {
          if (!cancelled) {
            setStatusError(
              error instanceof Error
                ? error.message
                : "WhatsApp status is unavailable."
            )
          }
        })
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [applySetupStatus, context, isOpen, managedAccountKey])

  React.useEffect(() => {
    const current = context
    if (!current || !attempt || !isActiveWhatsAppAttempt(attempt.state)) return
    let cancelled = false
    let failures = 0
    let timer: number | undefined
    const schedule = (delayMs: number) => {
      timer = window.setTimeout(poll, delayMs)
    }
    const poll = () => {
      void controlApi
        .whatsappLinkAttempt(
          current.agentKey,
          attempt.accountKey,
          attempt.attemptId
        )
        .then(async ({ attempt: next }) => {
          if (cancelled) return
          failures = 0
          setAttemptPollError(null)
          setAttempt(next)
          if (next.state === "linked") {
            setSetupStatus((status) =>
              status
                ? {
                    ...status,
                    account: {
                      ...status.account,
                      authStored: true,
                      enabled: true,
                      linked: true,
                      status: "enabled",
                      providerAccountId: next.providerAccountId,
                    },
                  }
                : status
            )
            toast.success("WhatsApp account linked")
            await invalidate(agentCacheKey(current.agentKey))
            await refreshSetupStatus(next.accountKey).catch(() => undefined)
            return
          }
          if (isActiveWhatsAppAttempt(next.state)) schedule(2_000)
        })
        .catch((error) => {
          if (cancelled) return
          failures += 1
          setAttemptPollError(
            error instanceof Error
              ? error.message
              : "WhatsApp link status is unavailable."
          )
          if (failures < 3) schedule(2_000 * 2 ** (failures - 1))
        })
    }
    schedule(2_000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [attempt, context, invalidate, pollGeneration, refreshSetupStatus])

  const link = useMutation({
    mutationFn: async (values: WhatsAppConnectorFormValues) => {
      const current = requireContext(context)
      const accountKey = values.accountKey.trim()
      if (!managedAccountKey) {
        const { connector } = await controlApi.upsertConnector(
          current.agentKey,
          whatsappConnectorPayload(values),
          auth.csrfToken
        )
        setCreatedAccountKey(accountKey)
        setSetupStatus({
          agentKey: current.agentKey,
          accountKey,
          account: {
            exists: true,
            enabled: false,
            linked: false,
            authStored: false,
            status: connector.status,
            connectorKey: connector.connectorKey,
            displayName: connector.displayName,
          },
          runtime: { state: "offline", stale: true },
        })
      }
      return controlApi.startWhatsAppLink(
        current.agentKey,
        accountKey,
        values.phone,
        auth.csrfToken
      )
    },
    onSuccess: async ({ attempt: next }) => {
      setAttempt(next)
      setAttemptPollError(null)
      setManagementError(null)
      toast.success("WhatsApp pairing started")
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const cancel = useMutation({
    mutationFn: async () => {
      const current = requireContext(context)
      if (!attempt) throw new Error("No WhatsApp link attempt is active.")
      return controlApi.cancelWhatsAppLink(
        current.agentKey,
        attempt.accountKey,
        attempt.attemptId,
        auth.csrfToken
      )
    },
    onSuccess: async ({ attempt: next }) => {
      setAttempt(next)
      setManagementError(null)
      toast.success("WhatsApp pairing cancelled")
      if (managedAccountKey)
        await refreshSetupStatus(managedAccountKey).catch(() => undefined)
    },
    onError: (error) => {
      setManagementError(
        error instanceof Error
          ? error.message
          : "WhatsApp pairing could not be cancelled."
      )
    },
  })
  const setEnabled = useMutation({
    mutationFn: async (enabled: boolean) => {
      const current = requireContext(context)
      if (!managedAccountKey)
        throw new Error("WhatsApp account is not available.")
      return controlApi.setConnectorEnabled(
        current.agentKey,
        { source: "whatsapp", accountKey: managedAccountKey },
        enabled,
        auth.csrfToken
      )
    },
    onSuccess: async ({ connector }) => {
      setManagementError(null)
      setSetupStatus((status) =>
        status
          ? {
              ...status,
              account: {
                ...status.account,
                enabled: connector.status === "enabled",
                status: connector.status,
              },
            }
          : status
      )
      toast.success(
        connector.status === "enabled"
          ? "WhatsApp account enabled"
          : "WhatsApp account disabled"
      )
      await invalidate(agentCacheKey(context?.agentKey))
      await refreshSetupStatus(connector.accountKey).catch(() => undefined)
    },
    onError: (error) => {
      setManagementError(
        error instanceof Error
          ? error.message
          : "WhatsApp account status could not be changed."
      )
    },
  })
  const reset = useMutation({
    mutationFn: async () => {
      const current = requireContext(context)
      if (!managedAccountKey)
        throw new Error("WhatsApp account is not available.")
      return controlApi.resetWhatsAppLink(
        current.agentKey,
        managedAccountKey,
        auth.csrfToken
      )
    },
    onSuccess: async ({ connector }) => {
      setAttempt(null)
      setManagementError(null)
      setResetDialogOpen(false)
      toast.success("WhatsApp local link reset")
      await invalidate(agentCacheKey(context?.agentKey))
      await refreshSetupStatus(connector.accountKey).catch(() => undefined)
    },
    onError: (error) => {
      setManagementError(
        error instanceof Error
          ? error.message
          : "WhatsApp local link could not be reset."
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: whatsappConnectorSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await link.mutateAsync(value)
        formApi.reset(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: whatsappConnectorErrorFields,
        })
      }
    },
  })

  const stage = resolveWhatsAppSetupStage({
    hasAccount: Boolean(managedAccountKey),
    account: setupStatus?.account,
    attemptState: attempt?.state,
  })
  const active = isActiveWhatsAppAttempt(attempt?.state)
  const canStartLink = (stage === "create" || stage === "link") && !statusError
  const { canDisable, canEnable, canReset } = resolveWhatsAppManagementActions(
    setupStatus?.account
  )
  return (
    <FormSheet
      cancelLabel={canStartLink ? "Cancel" : "Close"}
      description={
        managedAccountKey
          ? "Manage this account’s link, worker state, and local authentication."
          : "Create an agent-owned account, then enter the one-time code in WhatsApp → Linked devices. The phone number and code are never stored."
      }
      form={form}
      hideSubmit={!canStartLink}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={setWhatsAppSheetOpen}
      submitLabel={stage === "create" ? "Create and link" : "Start linking"}
      title={
        managedAccountKey ? `WhatsApp · ${managedAccountKey}` : "WhatsApp setup"
      }
    >
      {stage === "create" ? (
        <>
          <form.AppField name="accountKey">
            {(field) => (
              <field.TextField
                label="Account key"
                autoComplete="off"
                autoFocus
                description="Stable operator-facing name. It cannot be changed later."
                placeholder="main"
                required
              />
            )}
          </form.AppField>
          <form.AppField name="displayName">
            {(field) => <field.TextField label="Display name" />}
          </form.AppField>
        </>
      ) : null}
      {setupStatus ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-2 rounded-lg border p-3 text-sm">
          <span className="text-muted-foreground">Account</span>
          <span>{displayWhatsAppState(setupStatus.account.status)}</span>
          <span className="text-muted-foreground">Linked</span>
          <span>{setupStatus.account.linked ? "Yes" : "No"}</span>
          <span className="text-muted-foreground">Local auth</span>
          <span>{setupStatus.account.authStored ? "Stored" : "Missing"}</span>
          <span className="text-muted-foreground">Worker</span>
          <span>
            {setupStatus.runtime.stale
              ? "Offline"
              : displayWhatsAppState(setupStatus.runtime.state)}
          </span>
          {setupStatus.account.providerAccountId ? (
            <>
              <span className="text-muted-foreground">Provider</span>
              <span className="truncate font-mono text-xs">
                {setupStatus.account.providerAccountId}
              </span>
            </>
          ) : null}
          {setupStatus.runtime.lastError ? (
            <>
              <span className="text-muted-foreground">Last error</span>
              <span className="text-destructive">
                {displayWhatsAppState(setupStatus.runtime.lastError)}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {stage === "loading" ? (
        <p className="text-sm text-muted-foreground">
          Loading WhatsApp account state…
        </p>
      ) : null}
      {statusError ? (
        <div className="grid gap-2 rounded-lg border border-destructive/40 p-3">
          <p className="text-sm text-destructive">{statusError}</p>
          {managedAccountKey ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void refreshSetupStatus(managedAccountKey).catch((error) => {
                  setStatusError(
                    error instanceof Error
                      ? error.message
                      : "WhatsApp status is unavailable."
                  )
                })
              }
            >
              Retry status
            </Button>
          ) : null}
        </div>
      ) : null}
      {canStartLink ? (
        <form.AppField name="phone">
          {(field) => (
            <field.TextField
              label="Phone number"
              autoComplete="tel"
              autoFocus={stage === "link"}
              description="Include country code. Control sends it to WhatsApp only for this pairing attempt."
              placeholder="+421900000000"
              required
            />
          )}
        </form.AppField>
      ) : null}
      {attempt ? (
        <div className="grid gap-3 rounded-lg border p-4">
          <div className="text-sm font-medium">
            Link status: {displayWhatsAppState(attempt.state)}
          </div>
          {attempt.pairingCode ? (
            <>
              <p className="text-sm text-muted-foreground">
                On your phone, open WhatsApp → Linked devices → Link a device →
                Link with phone number, then enter this code.
              </p>
              <div
                aria-label="WhatsApp pairing code"
                className="rounded-md bg-muted p-4 text-center font-mono text-2xl font-semibold tracking-[0.2em]"
              >
                {attempt.pairingCode}
              </div>
              <p className="text-xs text-muted-foreground">
                Expires at {new Date(attempt.expiresAt).toLocaleTimeString()}.
              </p>
            </>
          ) : null}
          {attempt.error ? (
            <p className="text-sm text-destructive">{attempt.error}</p>
          ) : null}
          {attemptPollError ? (
            <div className="grid gap-2">
              <p className="text-sm text-destructive">{attemptPollError}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPollGeneration((value) => value + 1)}
              >
                Retry link status
              </Button>
            </div>
          ) : null}
          {active ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              Cancel pairing
            </Button>
          ) : null}
        </div>
      ) : null}
      {stage === "connected" ? (
        <p className="text-sm text-muted-foreground">
          This account is linked and enabled. Panda will supervise its WhatsApp
          worker.
        </p>
      ) : null}
      {stage === "disabled" ? (
        <p className="text-sm text-muted-foreground">
          The link is stored, but the account is disabled. Enable it to resume
          the worker.
        </p>
      ) : null}
      {stage === "error" ? (
        <p className="text-sm text-destructive">
          The worker cannot use this link. Reset Panda’s local auth, then link
          the account again.
        </p>
      ) : null}
      {stage === "reset_required" ? (
        <p className="text-sm text-destructive">
          The local link is incomplete or stale. Reset it before starting
          another pairing attempt.
        </p>
      ) : null}
      {managementError ? (
        <p className="text-sm text-destructive">{managementError}</p>
      ) : null}
      {managedAccountKey && !active && !statusError ? (
        <div className="flex flex-wrap gap-2">
          {canDisable ? (
            <Button
              type="button"
              variant="outline"
              disabled={setEnabled.isPending}
              onClick={() => setEnabled.mutate(false)}
            >
              Disable account
            </Button>
          ) : null}
          {canEnable ? (
            <Button
              type="button"
              disabled={setEnabled.isPending}
              onClick={() => setEnabled.mutate(true)}
            >
              Enable account
            </Button>
          ) : null}
          {canReset ? (
            <AlertDialog
              open={resetDialogOpen}
              onOpenChange={setResetDialogOpen}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={reset.isPending}
                >
                  Reset local link
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset WhatsApp link?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes Panda’s local WhatsApp auth for{" "}
                    {managedAccountKey}. It does not remove the device from
                    WhatsApp’s Linked devices screen.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={reset.isPending}>
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={reset.isPending}
                    onClick={() => reset.mutate()}
                  >
                    Reset local link
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      ) : null}
    </FormSheet>
  )
}

export function EmailConnectorSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useEmailConnectorSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        emailConnectorDefaults,
        defaultData ?? (entity ? connectorToEmailFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: EmailConnectorFormValues) => {
      const current = requireContext(context)
      return controlApi.upsertConnector(
        current.agentKey,
        emailConnectorPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Email connector saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: emailConnectorSchema(!entity) },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: emailConnectorErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Update email account" : "Save email account",
        description: entity
          ? "This updates email account settings. Filled username or password fields rotate the stored credentials."
          : "This stores email account settings and write-only IMAP/SMTP credentials for this agent.",
        confirmLabel: "Save account",
      }}
      description={
        entity
          ? "Secret fields are optional on update. Stored values stay write-only."
          : "Create an email account with write-only IMAP and SMTP credentials."
      }
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Save account"
      title={entity ? "Edit Email account" : "Email account"}
    >
      <form.AppField name="accountKey">
        {(field) => (
          <field.TextField
            label="Account key"
            autoComplete="off"
            autoFocus
            disabled={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="displayName">
        {(field) => <field.TextField label="Display name" />}
      </form.AppField>
      <form.AppField name="fromAddress">
        {(field) => (
          <field.TextField label="From address" autoComplete="email" required />
        )}
      </form.AppField>
      <form.AppField name="fromName">
        {(field) => <field.TextField label="From name" autoComplete="name" />}
      </form.AppField>
      <form.AppField name="mailboxes">
        {(field) => (
          <field.TextField
            label="Mailboxes"
            description="Comma-separated mailbox names to sync."
            required
          />
        )}
      </form.AppField>
      <div className="grid gap-3 rounded-md border p-3">
        <div className="text-sm font-medium">IMAP</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="imapHost">
            {(field) => <field.TextField label="Host" required />}
          </form.AppField>
          <form.AppField name="imapPort">
            {(field) => <field.TextField label="Port" />}
          </form.AppField>
        </div>
        <form.AppField name="imapSecure">
          {(field) => (
            <field.SelectField
              label="Security"
              options={secureModeOptions}
              required
            />
          )}
        </form.AppField>
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="imapUsername">
            {(field) => (
              <field.TextField
                label="Username"
                autoComplete="username"
                description={
                  entity
                    ? "Leave blank to keep the stored username."
                    : undefined
                }
                required={!entity}
              />
            )}
          </form.AppField>
          <form.AppField name="imapPassword">
            {(field) => (
              <field.TextField
                label="Password"
                autoComplete="new-password"
                type="password"
                description={
                  entity
                    ? "Leave blank to keep the stored password."
                    : undefined
                }
                required={!entity}
              />
            )}
          </form.AppField>
        </div>
      </div>
      <div className="grid gap-3 rounded-md border p-3">
        <div className="text-sm font-medium">SMTP</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="smtpHost">
            {(field) => <field.TextField label="Host" required />}
          </form.AppField>
          <form.AppField name="smtpPort">
            {(field) => <field.TextField label="Port" />}
          </form.AppField>
        </div>
        <form.AppField name="smtpSecure">
          {(field) => (
            <field.SelectField
              label="Security"
              options={secureModeOptions}
              required
            />
          )}
        </form.AppField>
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="smtpUsername">
            {(field) => (
              <field.TextField
                label="Username"
                autoComplete="username"
                description={
                  entity
                    ? "Leave blank to keep the stored username."
                    : undefined
                }
                required={!entity}
              />
            )}
          </form.AppField>
          <form.AppField name="smtpPassword">
            {(field) => (
              <field.TextField
                label="Password"
                autoComplete="new-password"
                type="password"
                description={
                  entity
                    ? "Leave blank to keep the stored password."
                    : undefined
                }
                required={!entity}
              />
            )}
          </form.AppField>
        </div>
      </div>
    </FormSheet>
  )
}

export function BindingSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } = useBindingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(bindingDefaults, {
        ...defaultData,
        sessionId: defaultData?.sessionId ?? context?.sessionId ?? "",
      }),
    [context?.sessionId, defaultData]
  )
  const [connectorSource, setConnectorSource] = React.useState(
    resetValues.source
  )
  const setBindingSheetOpen = (open: boolean) => {
    if (!open) setConnectorSource(resetValues.source)
    setOpen(open)
  }
  const sessionPicker = useSessionOptions(
    context,
    isOpen,
    resetValues.sessionId
  )
  const connectorPicker = useConnectorOptions(
    context,
    isOpen,
    resetValues.connectorKey,
    connectorSource
  )
  const mutation = useMutation({
    mutationFn: (values: BindingFormValues) => {
      const current = requireContext(context)
      return controlApi.bindConversation(
        current.agentKey,
        bindingPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Conversation bound")
      setBindingSheetOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: bindingSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: bindingErrorFields,
        })
      }
    },
  })

  const connectorDescription =
    !connectorPicker.isLoading && connectorPicker.options.length === 0
      ? `Add ${sourceAccountLabel(connectorSource)} on the Connectors tab before binding a conversation.`
      : "Choose one of this agent's connector accounts."

  return (
    <FormSheet
      description="Route an external conversation into a visible session."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={setBindingSheetOpen}
      submitDisabled={
        connectorPicker.isLoading ||
        connectorPicker.options.length === 0 ||
        sessionPicker.isLoading ||
        sessionPicker.options.length === 0
      }
      submitLabel="Bind"
      title="Bind conversation"
    >
      <form.AppField name="source">
        {(field) => (
          <field.SelectField
            label="Source"
            options={bindingSourceOptions}
            onValueChange={(source) => {
              setConnectorSource(source)
              form.setFieldValue("connectorKey", "")
            }}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="connectorKey">
        {(field) => (
          <field.ComboboxField
            label="Connector"
            description={connectorDescription}
            disabled={
              connectorPicker.isLoading || connectorPicker.options.length === 0
            }
            options={connectorPicker.options}
            placeholder={
              connectorPicker.isLoading
                ? "Loading connectors"
                : connectorPicker.options.length === 0
                  ? "No connectors"
                  : "Select connector"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="externalConversationId">
        {(field) => (
          <field.TextField
            label="External conversation id"
            autoComplete="off"
            description="Paste the channel or conversation id from the external system."
            required
          />
        )}
      </form.AppField>
      <form.AppField name="sessionId">
        {(field) => (
          <field.ComboboxField
            label="Session"
            description={
              context?.sessionId
                ? "Targeting the current session."
                : "Choose the visible session that should receive this conversation."
            }
            disabled={
              Boolean(context?.sessionId) ||
              sessionPicker.isLoading ||
              sessionPicker.options.length === 0
            }
            options={sessionPicker.options}
            placeholder={
              sessionPicker.isLoading
                ? "Loading sessions"
                : sessionPicker.options.length === 0
                  ? "No sessions"
                  : "Select session"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="displayName">
        {(field) => <field.TextField label="Display name" />}
      </form.AppField>
    </FormSheet>
  )
}

export function DiscordActorPairingSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } =
    useDiscordActorPairingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(discordActorPairingDefaults, defaultData),
    [defaultData]
  )
  const accountPicker = useDiscordAccountOptions(
    context,
    isOpen,
    resetValues.accountKey
  )
  const identityPicker = useAgentPairedIdentityOptions(
    context?.agentKey,
    isOpen,
    resetValues.identityId
  )
  const mutation = useMutation({
    mutationFn: (values: DiscordActorPairingFormValues) => {
      const current = requireContext(context)
      return controlApi.pairDiscordActor(
        current.agentKey,
        discordActorPairingPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Discord actor paired")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: discordActorPairingSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: discordActorPairingErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Pair Discord actor",
        description:
          "This maps one Discord user id to a Panda identity for inbound Discord actor resolution.",
        confirmLabel: "Pair actor",
      }}
      description="Pair a numeric Discord user id/snowflake to a Panda identity."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitDisabled={
        accountPicker.isLoading ||
        accountPicker.options.length === 0 ||
        identityPicker.isLoading ||
        identityPicker.options.length === 0
      }
      submitLabel="Pair actor"
      title="Discord actor pairing"
    >
      <form.AppField name="accountKey">
        {(field) => (
          <field.ComboboxField
            label="Discord account"
            disabled={
              accountPicker.isLoading || accountPicker.options.length === 0
            }
            options={accountPicker.options}
            placeholder={
              accountPicker.isLoading
                ? "Loading Discord accounts"
                : accountPicker.options.length === 0
                  ? "No Discord accounts"
                  : "Select account"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="externalActorId">
        {(field) => (
          <field.TextField
            label="Discord user id"
            autoComplete="off"
            autoFocus
            description="Paste the numeric Discord snowflake. Usernames, display names, and @mentions will not work."
            inputMode="numeric"
            placeholder="234567890123456789"
            required
          />
        )}
      </form.AppField>
      <form.AppField name="identityId">
        {(field) => (
          <field.ComboboxField
            label="Identity"
            disabled={
              identityPicker.isLoading || identityPicker.options.length === 0
            }
            options={identityPicker.options}
            placeholder={
              identityPicker.isLoading
                ? "Loading identities"
                : identityPicker.options.length === 0
                  ? "No identities"
                  : "Select identity"
            }
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function ChannelActorPairingSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } =
    useChannelActorPairingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(channelActorPairingDefaults, defaultData),
    [defaultData]
  )
  const [source, setSource] = React.useState(resetValues.source)
  const setChannelActorSheetOpen = (open: boolean) => {
    if (!open) setSource(resetValues.source)
    setOpen(open)
  }
  const identityPicker = useAgentPairedIdentityOptions(
    context?.agentKey,
    isOpen,
    resetValues.identityId
  )
  const connectorPicker = useConnectorOptions(
    context,
    isOpen,
    source === resetValues.source ? resetValues.connectorKey : undefined,
    source,
    "enabled"
  )
  const mutation = useMutation({
    mutationFn: (values: ChannelActorPairingFormValues) => {
      const current = requireContext(context)
      return controlApi.pairChannelActor(
        current.agentKey,
        channelActorPairingPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Channel actor paired")
      setChannelActorSheetOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: channelActorPairingSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: channelActorPairingErrorFields,
        })
      }
    },
  })

  const connectorDescription =
    source === "whatsapp"
      ? "Select the agent-owned WhatsApp account; the connector key is assigned by Panda."
      : "Select one of this agent's enabled Telegram connector accounts."
  const actorDescription =
    source === "whatsapp"
      ? "Paste the exact actor JID observed by Panda. Keep @lid identifiers unchanged; do not substitute a phone number."
      : "Numeric Telegram user id. Usernames and @handles will not work."

  return (
    <FormSheet
      confirmSubmit={{
        title: "Pair channel actor",
        description:
          "This maps one Telegram or WhatsApp actor to a Panda identity for inbound channel resolution.",
        confirmLabel: "Pair actor",
      }}
      description="Pair a Telegram or WhatsApp actor to an identity already paired with this agent."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={setChannelActorSheetOpen}
      submitDisabled={
        identityPicker.isLoading ||
        identityPicker.options.length === 0 ||
        connectorPicker.isLoading ||
        connectorPicker.options.length === 0
      }
      submitLabel="Pair actor"
      title="Channel actor pairing"
    >
      <form.AppField name="source">
        {(field) => (
          <field.SelectField
            label="Source"
            options={channelActorSourceOptions}
            onValueChange={(nextSource) => {
              const normalized =
                nextSource === "whatsapp" ? "whatsapp" : "telegram"
              setSource(normalized)
              form.setFieldValue("connectorKey", "")
              form.setFieldValue("externalActorId", "")
            }}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="connectorKey">
        {(field) => (
          <field.ComboboxField
            label={
              source === "whatsapp" ? "WhatsApp account" : "Telegram connector"
            }
            description={connectorDescription}
            disabled={
              connectorPicker.isLoading || connectorPicker.options.length === 0
            }
            options={connectorPicker.options}
            placeholder={
              connectorPicker.isLoading
                ? `Loading ${source} accounts`
                : connectorPicker.options.length === 0
                  ? `No enabled ${source} accounts`
                  : `Select ${source} account`
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="externalActorId">
        {(field) => (
          <field.TextField
            label={
              source === "whatsapp" ? "WhatsApp actor" : "Telegram user id"
            }
            autoComplete="off"
            autoFocus
            description={actorDescription}
            inputMode={source === "telegram" ? "numeric" : "text"}
            placeholder={
              source === "whatsapp" ? "246664333885442@lid" : "123456789"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="identityId">
        {(field) => (
          <field.ComboboxField
            label="Identity"
            description="Pick an identity that is paired with this agent."
            disabled={
              identityPicker.isLoading || identityPicker.options.length === 0
            }
            options={identityPicker.options}
            placeholder={
              identityPicker.isLoading
                ? "Loading identities"
                : identityPicker.options.length === 0
                  ? "No identities"
                  : "Select identity"
            }
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function EmailRecipientAllowRuleSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } =
    useEmailRecipientAllowRuleSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(emailRecipientAllowRuleDefaults, defaultData),
    [defaultData]
  )
  const accountPicker = useEmailAccountOptions(
    context,
    isOpen,
    resetValues.accountKey
  )
  const mutation = useMutation({
    mutationFn: (values: EmailRecipientAllowRuleFormValues) => {
      const current = requireContext(context)
      return controlApi.addEmailRecipientAllowRule(
        current.agentKey,
        emailRecipientAllowRulePayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Email recipient allow rule saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: emailRecipientAllowRuleSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: emailRecipientAllowRuleErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Allow email recipients",
        description:
          "An exact address permits one mailbox. An entire-domain rule permits every current and future mailbox at that exact domain, but not its subdomains.",
        confirmLabel: "Allow recipients",
      }}
      description="Allow one exact address or every mailbox at one exact domain."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitDisabled={
        accountPicker.isLoading || accountPicker.options.length === 0
      }
      submitLabel="Add allow rule"
      title="Email recipient allow rule"
    >
      <form.AppField name="accountKey">
        {(field) => (
          <field.ComboboxField
            label="Email account"
            disabled={
              accountPicker.isLoading || accountPicker.options.length === 0
            }
            options={accountPicker.options}
            placeholder={
              accountPicker.isLoading
                ? "Loading email accounts"
                : accountPicker.options.length === 0
                  ? "No email accounts"
                  : "Select account"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="kind">
        {(field) => (
          <field.SelectField
            label="Rule type"
            description="Domain rules include every mailbox at that exact domain."
            options={emailRecipientAllowRuleKindOptions}
            onValueChange={() => form.setFieldValue("value", "")}
            required
          />
        )}
      </form.AppField>
      <form.Subscribe
        selector={(state: { values: EmailRecipientAllowRuleFormValues }) =>
          state.values.kind
        }
      >
        {(kind: EmailRecipientAllowRuleFormValues["kind"]) => (
          <form.AppField name="value">
            {(field) => (
              <field.TextField
                label={kind === "domain" ? "Recipient domain" : "Recipient address"}
                autoComplete={kind === "domain" ? "off" : "email"}
                description={
                  kind === "domain"
                    ? "Every current and future mailbox at this exact domain is allowed; subdomains are excluded."
                    : "Only this exact address is allowed."
                }
                placeholder={kind === "domain" ? "company.com" : "person@company.com"}
                required
              />
            )}
          </form.AppField>
        )}
      </form.Subscribe>
    </FormSheet>
  )
}

export function EmailRouteSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } = useEmailRouteSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        emailRouteDefaults,
        defaultData ?? (entity ? emailRouteToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const accountPicker = useEmailAccountOptions(
    context,
    isOpen,
    resetValues.accountKey
  )
  const sessionPicker = useSessionOptions(
    context,
    isOpen,
    resetValues.sessionId
  )
  const mutation = useMutation({
    mutationFn: (values: EmailRouteFormValues) => {
      const current = requireContext(context)
      return controlApi.setEmailRoute(
        current.agentKey,
        emailRoutePayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Email route saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: emailRouteSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: emailRouteErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Update email route" : "Save email route",
        description: entity
          ? "This changes the target session for the selected email route."
          : "This routes inbound mail for the account or mailbox into a visible session.",
        confirmLabel: "Save route",
      }}
      description={
        entity
          ? "Account and mailbox identify the route. Delete and recreate the route to change either."
          : "Choose the email account and session. Leave mailbox empty for the account-level fallback route."
      }
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitDisabled={
        accountPicker.isLoading ||
        accountPicker.options.length === 0 ||
        sessionPicker.isLoading ||
        sessionPicker.options.length === 0
      }
      submitLabel="Save route"
      title={entity ? "Edit email route" : "Email route"}
    >
      <form.AppField name="accountKey">
        {(field) => (
          <field.ComboboxField
            label="Email account"
            disabled={
              Boolean(entity) ||
              accountPicker.isLoading ||
              accountPicker.options.length === 0
            }
            options={accountPicker.options}
            placeholder={
              accountPicker.isLoading
                ? "Loading email accounts"
                : accountPicker.options.length === 0
                  ? "No email accounts"
                  : "Select account"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="mailbox">
        {(field) => (
          <field.TextField
            label="Mailbox"
            autoComplete="off"
            description="Optional. Empty means the account fallback route."
            disabled={Boolean(entity)}
          />
        )}
      </form.AppField>
      <form.AppField name="sessionId">
        {(field) => (
          <field.ComboboxField
            label="Session"
            disabled={
              sessionPicker.isLoading || sessionPicker.options.length === 0
            }
            options={sessionPicker.options}
            placeholder={
              sessionPicker.isLoading
                ? "Loading sessions"
                : sessionPicker.options.length === 0
                  ? "No sessions"
                  : "Select session"
            }
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

function sourceAccountLabel(source: string) {
  if (source === "email") return "an email account"
  if (source === "telegram") return "a Telegram account"
  if (source === "whatsapp") return "a WhatsApp account"
  return "a Discord account"
}
