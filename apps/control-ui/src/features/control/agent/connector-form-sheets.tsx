import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
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
  emailAllowedRecipientDefaults,
  emailConnectorDefaults,
  emailRouteDefaults,
  emailRouteToFormValues,
} from "@/features/control/forms/form-values"
import {
  bindingPayload,
  channelActorPairingPayload,
  discordActorPairingPayload,
  discordConnectorPayload,
  emailAllowedRecipientPayload,
  emailConnectorPayload,
  emailRoutePayload,
} from "@/features/control/forms/form-payloads"
import {
  useBindingSheet,
  useChannelActorPairingSheet,
  useDiscordActorPairingSheet,
  useDiscordConnectorSheet,
  useEmailAllowedRecipientSheet,
  useEmailConnectorSheet,
  useEmailRouteSheet,
  type BindingFormValues,
  type ChannelActorPairingFormValues,
  type DiscordActorPairingFormValues,
  type DiscordConnectorFormValues,
  type EmailAllowedRecipientFormValues,
  type EmailConnectorFormValues,
  type EmailRouteFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import {
  useConnectorOptions,
  useDiscordAccountOptions,
  useEmailAccountOptions,
  useIdentityOptions,
  useSessionOptions,
} from "@/features/control/forms/form-options"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { handleControlFormError } from "@/lib/form-errors"

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

const emailAllowedRecipientSchema = z.object({
  accountKey: z.string().trim().min(1, "Email account is required."),
  address: z.string().trim().email("Enter a valid recipient address."),
})

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
      (!/^\d+$/.test(value.externalActorId) || !/[1-9]/.test(value.externalActorId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Telegram actor id must be a positive numeric user id.",
        path: ["externalActorId"],
      })
    }
    if (value.source === "whatsapp") {
      const jid = /^(\d{8,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/i.test(
        value.externalActorId
      )
      const digits = value.externalActorId.replace(/[^\d]/g, "")
      if (!jid && (digits.length < 8 || digits.length > 15)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Use a phone number, @s.whatsapp.net JID, or @lid JID.",
          path: ["externalActorId"],
        })
      }
    }
  })

const bindingSourceOptions = [
  { label: "Discord", value: "discord" },
  { label: "Email", value: "email" },
  { label: "Telegram", value: "telegram" },
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

const emailAllowedRecipientErrorFields = {
  "email allowlist account key": "accountKey",
  "email account": "accountKey",
  "email allowlist recipient address": "address",
}

const discordActorPairingErrorFields = {
  "discord account key": "accountKey",
  "discord account": "accountKey",
  "discord actor": "externalActorId",
  "discord actor id": "externalActorId",
  "identity": "identityId",
  "connector account": "accountKey",
}

const channelActorPairingErrorFields = {
  "channel actor pairing source": "source",
  "telegram connector key": "connectorKey",
  "whatsapp connector key": "connectorKey",
  "telegram actor id": "externalActorId",
  "whatsapp actor": "externalActorId",
  "identity": "identityId",
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
        defaultData ?? (entity ? connectorToDiscordFormValues(entity) : undefined)
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
          <field.TextField
            label="From address"
            autoComplete="email"
            required
          />
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
                  entity ? "Leave blank to keep the stored username." : undefined
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
                  entity ? "Leave blank to keep the stored password." : undefined
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
                  entity ? "Leave blank to keep the stored username." : undefined
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
                  entity ? "Leave blank to keep the stored password." : undefined
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
  const [connectorSource, setConnectorSource] = React.useState(resetValues.source)
  React.useEffect(() => {
    if (isOpen) setConnectorSource(resetValues.source)
  }, [isOpen, resetValues.source])
  const sessionPicker = useSessionOptions(context, isOpen, resetValues.sessionId)
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
      setOpen(false)
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
      setIsOpen={(open) => setOpen(open)}
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
  const identityPicker = useIdentityOptions(isOpen, resetValues.identityId)
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
  React.useEffect(() => {
    if (isOpen) setSource(resetValues.source)
  }, [isOpen, resetValues.source])
  const identityPicker = useIdentityOptions(isOpen, resetValues.identityId)
  const connectorPicker = useConnectorOptions(
    context,
    isOpen && source === "telegram",
    resetValues.connectorKey,
    "telegram"
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
      setOpen(false)
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
      ? "Usually main unless WHATSAPP_CONNECTOR_KEY points at another connector."
      : connectorPicker.options.length > 0
        ? "Choose one of this agent's Telegram connector accounts."
        : "Use the bot id returned by panda telegram account whoami."
  const actorDescription =
    source === "whatsapp"
      ? "Phone number or WhatsApp JID. Phone numbers are stored as @s.whatsapp.net."
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
      setIsOpen={(open) => setOpen(open)}
      submitDisabled={identityPicker.isLoading || identityPicker.options.length === 0}
      submitLabel="Pair actor"
      title="Channel actor pairing"
    >
      <form.AppField name="source">
        {(field) => (
          <field.SelectField
            label="Source"
            options={channelActorSourceOptions}
            onValueChange={(nextSource) => {
              const normalized = nextSource === "whatsapp" ? "whatsapp" : "telegram"
              setSource(normalized)
              form.setFieldValue("connectorKey", normalized === "whatsapp" ? "main" : "")
              form.setFieldValue("externalActorId", "")
            }}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="connectorKey">
        {(field) =>
          source === "telegram" && connectorPicker.options.length > 0 ? (
            <field.ComboboxField
              label="Telegram connector"
              description={connectorDescription}
              disabled={connectorPicker.isLoading}
              options={connectorPicker.options}
              placeholder={
                connectorPicker.isLoading ? "Loading Telegram connectors" : "Select connector"
              }
              required
            />
          ) : (
            <field.TextField
              label="Connector key"
              autoComplete="off"
              description={connectorDescription}
              placeholder={source === "whatsapp" ? "main" : "123456789"}
              required
            />
          )
        }
      </form.AppField>
      <form.AppField name="externalActorId">
        {(field) => (
          <field.TextField
            label={source === "whatsapp" ? "WhatsApp actor" : "Telegram user id"}
            autoComplete="off"
            autoFocus
            description={actorDescription}
            inputMode={source === "telegram" ? "numeric" : "text"}
            placeholder={source === "whatsapp" ? "+421 900 123 456" : "123456789"}
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

export function EmailAllowedRecipientSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } =
    useEmailAllowedRecipientSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(emailAllowedRecipientDefaults, defaultData),
    [defaultData]
  )
  const accountPicker = useEmailAccountOptions(
    context,
    isOpen,
    resetValues.accountKey
  )
  const mutation = useMutation({
    mutationFn: (values: EmailAllowedRecipientFormValues) => {
      const current = requireContext(context)
      return controlApi.addEmailAllowedRecipient(
        current.agentKey,
        emailAllowedRecipientPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Allowed recipient saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: emailAllowedRecipientSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: emailAllowedRecipientErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Allow email recipient",
        description:
          "This permits the selected email account to send to this exact recipient address.",
        confirmLabel: "Allow recipient",
      }}
      description="Choose the email account and exact recipient address."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitDisabled={accountPicker.isLoading || accountPicker.options.length === 0}
      submitLabel="Allow recipient"
      title="Email recipient allowlist"
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
      <form.AppField name="address">
        {(field) => (
          <field.TextField
            label="Recipient address"
            autoComplete="email"
            description="Exact address this account may send to."
            placeholder="ops@example.com"
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function EmailRouteSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useEmailRouteSheet()
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
  const sessionPicker = useSessionOptions(context, isOpen, resetValues.sessionId)
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
  return "a Discord account"
}
