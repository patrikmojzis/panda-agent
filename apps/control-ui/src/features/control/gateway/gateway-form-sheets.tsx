import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
import {
  agentCacheKey,
  formError,
  mergedValues,
  requireContext,
  useInvalidateAgent,
} from "@/features/control/forms/form-sheet-shared"
import {
  useGatewaySourceOptions,
  useSessionOptions,
} from "@/features/control/forms/form-options"
import {
  gatewayDeviceDefaults,
  gatewayDevicePayload,
  gatewayEventTypeDefaults,
  gatewayEventTypePayload,
  gatewayEventTypeToFormValues,
  gatewaySourceDefaults,
  gatewaySourcePayload,
  gatewaySourceToFormValues,
  useGatewayDeviceSheet,
  useGatewayEventTypeSheet,
  useGatewayOneTimeSecretStore,
  useGatewaySourceSheet,
  type GatewayDeviceFormValues,
  type GatewayEventTypeFormValues,
  type GatewaySourceFormValues,
} from "@/features/control/gateway/gateway-form-model"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const gatewaySourceSchema = z.object({
  name: z.string(),
  sessionId: z.string(),
  sourceId: z.string().trim().min(1, "Source id is required."),
})

const gatewayDeviceSchema = z.object({
  capabilities: z
    .array(z.string())
    .min(1, "At least one capability is required."),
  deviceId: z.string().trim().min(1, "Device id is required."),
  label: z.string(),
  sourceId: z.string().trim().min(1, "Source id is required."),
})

const gatewayEventTypeSchema = z.object({
  delivery: z.enum(["queue", "wake"]),
  sourceId: z.string().trim().min(1, "Source id is required."),
  type: z
    .string()
    .trim()
    .min(1, "Event type is required.")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/,
      "Use letters, numbers, dots, colons, underscores, or hyphens."
    ),
})

const gatewayDeviceCapabilityOptions = [
  {
    label: "Push context",
    value: "push_context",
    description: "Send context events into Panda.",
  },
  {
    label: "Upload attachments",
    value: "upload_attachments",
    description: "Attach files or larger payloads to events.",
  },
  {
    label: "Claim commands",
    value: "claim_commands",
    description: "Poll and claim queued commands for this device.",
  },
  {
    label: "Capture screenshots",
    value: "screenshot.capture",
    description: "Receive screenshot capture commands.",
  },
]

export function GatewayFormSheets() {
  return (
    <>
      <GatewaySourceSheet />
      <GatewayDeviceSheet />
      <GatewayEventTypeSheet />
    </>
  )
}

function GatewaySourceSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useGatewaySourceSheet()
  const setLatestSourceSecret = useGatewayOneTimeSecretStore(
    (state) => state.setLatestSourceSecret
  )
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        gatewaySourceDefaults,
        defaultData ??
          (entity
            ? gatewaySourceToFormValues(entity)
            : { sessionId: context?.sessionId ?? "" })
      ),
    [context?.sessionId, defaultData, entity]
  )
  const sessionPicker = useSessionOptions(context, isOpen, resetValues.sessionId)
  const mutation = useMutation({
    mutationFn: (values: GatewaySourceFormValues) => {
      const current = requireContext(context)
      return controlApi.createGatewaySource(
        current.agentKey,
        gatewaySourcePayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async (result) => {
      toast.success("Gateway source created")
      setLatestSourceSecret(result.clientSecret)
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: gatewaySourceSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })
  return (
    <FormSheet
      confirmSubmit={{
        title: "Create gateway source",
        description:
          "This creates a source secret. The new client secret is shown once after creation.",
        confirmLabel: "Create source",
      }}
      description="The client secret is shown once after creation."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Create"
      title="Gateway Source"
    >
      <form.AppField name="sourceId">
        {(field) => (
          <field.TextField label="Source id" autoFocus required />
        )}
      </form.AppField>
      <form.AppField name="name">
        {(field) => <field.TextField label="Name" />}
      </form.AppField>
      <form.AppField name="sessionId">
        {(field) => (
          <field.ComboboxField
            label="Route session"
            description="Choose a session when this source should always route there."
            disabled={sessionPicker.isLoading}
            emptyLabel="No dedicated session"
            options={sessionPicker.options}
            placeholder={
              sessionPicker.isLoading ? "Loading sessions" : "No dedicated session"
            }
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

function GatewayDeviceSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } = useGatewayDeviceSheet()
  const setLatestDeviceToken = useGatewayOneTimeSecretStore(
    (state) => state.setLatestDeviceToken
  )
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(gatewayDeviceDefaults, {
        ...defaultData,
        sourceId: defaultData?.sourceId ?? context?.sourceId ?? "",
      }),
    [context?.sourceId, defaultData]
  )
  const sourcePicker = useGatewaySourceOptions(
    context,
    isOpen && !context?.sourceId,
    resetValues.sourceId
  )
  const mutation = useMutation({
    mutationFn: (values: GatewayDeviceFormValues) => {
      const current = requireContext(context)
      return controlApi.registerGatewayDevice(
        current.agentKey,
        values.sourceId.trim(),
        gatewayDevicePayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async (result) => {
      toast.success("Gateway device registered")
      setLatestDeviceToken(result.token)
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: gatewayDeviceSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Register gateway device",
        description:
          "This creates a device token. The token is shown once after registration.",
        confirmLabel: "Register device",
      }}
      description="The device token is shown once after registration."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Register"
      title="Gateway Device"
    >
      <form.AppField name="sourceId">
        {(field) =>
          context?.sourceId ? (
            <field.TextField
              label="Source id"
              autoFocus={false}
              disabled
              required
            />
          ) : (
            <field.ComboboxField
              label="Source"
              description="Choose the gateway source that owns this device."
              disabled={
                sourcePicker.isLoading || sourcePicker.options.length === 0
              }
              options={sourcePicker.options}
              placeholder={
                sourcePicker.isLoading ? "Loading sources" : "Choose source"
              }
              required
            />
          )
        }
      </form.AppField>
      <form.AppField name="deviceId">
        {(field) => <field.TextField label="Device id" required />}
      </form.AppField>
      <form.AppField name="label">
        {(field) => <field.TextField label="Label" />}
      </form.AppField>
      <form.AppField name="capabilities">
        {(field) => (
          <field.MultiSelectField
            label="Capabilities"
            description="Choose exactly what this device token is allowed to do."
            options={gatewayDeviceCapabilityOptions}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

function GatewayEventTypeSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useGatewayEventTypeSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        gatewayEventTypeDefaults,
        defaultData ??
          (entity
            ? gatewayEventTypeToFormValues(entity)
            : { sourceId: context?.sourceId ?? "" })
      ),
    [context?.sourceId, defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: GatewayEventTypeFormValues) => {
      const current = requireContext(context)
      return controlApi.upsertGatewayEventType(
        current.agentKey,
        values.sourceId.trim(),
        gatewayEventTypePayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Gateway event type allowed")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: gatewayEventTypeSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })
  const sourcePicker = useGatewaySourceOptions(
    context,
    isOpen && !context?.sourceId,
    resetValues.sourceId
  )

  return (
    <FormSheet
      confirmSubmit={{
        title: "Allow gateway event type",
        description:
          "This changes which events a gateway source may accept and whether they may wake the session immediately.",
        confirmLabel: "Allow event type",
      }}
      description="Allow a gateway source to accept a named event type."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel={entity ? "Update" : "Allow"}
      title="Gateway Event Type"
    >
      <form.AppField name="sourceId">
        {(field) =>
          context?.sourceId ? (
            <field.TextField
              label="Source id"
              autoFocus={false}
              disabled
              required
            />
          ) : (
            <field.ComboboxField
              label="Source"
              description="Choose the gateway source that may accept this event type."
              disabled={
                sourcePicker.isLoading || sourcePicker.options.length === 0
              }
              options={sourcePicker.options}
              placeholder={
                sourcePicker.isLoading ? "Loading sources" : "Choose source"
              }
              required
            />
          )
        }
      </form.AppField>
      <form.AppField name="type">
        {(field) => (
          <field.TextField
            label="Event type"
            disabled={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="delivery">
        {(field) => (
          <field.SelectField
            label="Delivery"
            description="Queue stores the event for later; wake makes the session runnable now."
            options={[
              { label: "Queue", value: "queue" },
              { label: "Wake", value: "wake" },
            ]}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}
