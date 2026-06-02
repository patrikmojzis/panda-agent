import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
import { controlKeys } from "@/features/control/api/query-key-factory"
import {
  agentCacheKey,
  formError,
  mergedValues,
  requireContext,
  useInvalidateAgent,
} from "@/features/control/forms/form-sheet-shared"
import {
  a2aBindingDefaults,
  briefingDefaults,
  briefingToFormValues,
  heartbeatConfigDefaults,
  heartbeatConfigToFormValues,
  runtimeConfigDefaults,
  runtimeConfigToFormValues,
  scheduledTaskDefaults,
  scheduledTaskToFormValues,
  sessionDefaults,
  sessionToFormValues,
  watchConfigDefaults,
  watchConfigToFormValues,
} from "@/features/control/forms/form-values"
import {
  a2aBindingPayload,
  briefingPayload,
  heartbeatConfigPayload,
  runtimeConfigPayload,
  scheduledTaskPayload,
  sessionLabelPayload,
  sessionPayload,
  watchConfigPayload,
} from "@/features/control/forms/form-payloads"
import {
  useA2ABindingSheet,
  useCreateSessionSheet,
  useBriefingSheet,
  useHeartbeatConfigSheet,
  useRuntimeConfigSheet,
  useScheduledTaskSheet,
  useUpdateSessionSheet,
  useWatchConfigSheet,
  type A2ABindingFormValues,
  type BriefingFormValues,
  type HeartbeatConfigFormValues,
  type RuntimeConfigFormValues,
  type ScheduledTaskFormValues,
  type SessionFormValues,
  type WatchConfigFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { useSessionOptions } from "@/features/control/forms/form-options"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const createSessionSchema = z.object({
  alias: z.string(),
  displayName: z.string(),
  kind: z.enum(["branch", "main"]),
})

const sessionLabelSchema = z.object({
  alias: z.string(),
  displayName: z.string(),
  kind: z.string(),
})

const runtimeConfigSchema = z.object({
  model: z.string(),
  thinking: z.enum(["default", "off", "low", "medium", "high", "xhigh"]),
})

const briefingSchema = z.object({
  content: z.string().trim().min(1, "Briefing is required."),
})

const heartbeatConfigSchema = z.object({
  enabled: z.boolean(),
  everyMinutes: z
    .string()
    .trim()
    .regex(/^\d+$/, "Cadence must be a whole number.")
    .refine((value) => Number.parseInt(value, 10) >= 15, "Cadence must be at least 15 minutes."),
})

const watchConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z
    .string()
    .trim()
    .regex(/^\d+$/, "Interval must be a whole number.")
    .refine((value) => Number.parseInt(value, 10) >= 1, "Interval must be at least 1 minute."),
  title: z.string().trim().min(1, "Title is required."),
})

const a2aBindingSchema = z.object({
  oneWay: z.boolean(),
  recipientSessionId: z.string().trim().min(1, "Recipient session is required."),
})

function scheduledTaskSchema(requiresInstruction: boolean) {
  return z
    .object({
      cron: z.string(),
      enabled: z.boolean(),
      instruction: z.string(),
      runAt: z.string(),
      scheduleKind: z.enum(["once", "recurring"]),
      timezone: z.string(),
      title: z.string().trim().min(1, "Title is required."),
    })
    .superRefine((value, context) => {
      if (requiresInstruction && !value.instruction.trim()) {
        context.addIssue({
          code: "custom",
          message: "Instruction is required.",
          path: ["instruction"],
        })
      }
      if (value.scheduleKind === "once" && Number.isNaN(new Date(value.runAt).getTime())) {
        context.addIssue({
          code: "custom",
          message: "Run time is required.",
          path: ["runAt"],
        })
      }
      if (value.scheduleKind === "recurring") {
        if (!value.cron.trim()) {
          context.addIssue({
            code: "custom",
            message: "Cron is required.",
            path: ["cron"],
          })
        }
        if (!value.timezone.trim()) {
          context.addIssue({
            code: "custom",
            message: "Timezone is required.",
            path: ["timezone"],
          })
        }
      }
    })
}

const kindOptions = [
  { label: "Branch session", value: "branch" },
  { label: "Main session", value: "main" },
]

const thinkingOptions = [
  { label: "Default", value: "default" },
  { label: "Off", value: "off" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "X high", value: "xhigh" },
]

const scheduleKindOptions = [
  { label: "Once", value: "once" },
  { label: "Recurring", value: "recurring" },
]

export function SessionCreateSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } = useCreateSessionSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(sessionDefaults, defaultData),
    [defaultData]
  )
  const mutation = useMutation({
    mutationFn: (values: SessionFormValues) => {
      const current = requireContext(context)
      return controlApi.createSession(
        current.agentKey,
        sessionPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Session created")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: createSessionSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Create"
      title="New session"
      description="Create a visible session for this agent."
    >
      <form.AppField name="displayName">
        {(field) => (
          <field.TextField
            label="Display name"
            description="Human-readable label for scanning tables and search."
            autoFocus
          />
        )}
      </form.AppField>
      <form.AppField name="alias">
        {(field) => (
          <field.TextField
            label="Alias"
            description="Optional short handle for operators. Leave blank to use the session id."
          />
        )}
      </form.AppField>
      <form.AppField name="kind">
        {(field) => (
          <field.SelectField
            label="Session type"
            description="Use branch for ordinary work. Use main only for the agent's durable primary lane."
            options={kindOptions}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionUpdateSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useUpdateSessionSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        sessionDefaults,
        defaultData ?? (entity ? sessionToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: SessionFormValues) => {
      const current = requireContext(context)
      if (!entity) throw new Error("Session is missing.")
      return controlApi.updateSession(
        current.agentKey,
        entity.id,
        sessionLabelPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Session label updated")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: sessionLabelSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      title="Edit Session"
    >
      <form.AppField name="displayName">
        {(field) => <field.TextField label="Display name" autoFocus />}
      </form.AppField>
      <form.AppField name="alias">
        {(field) => <field.TextField label="Alias" />}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionRuntimeConfigSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useRuntimeConfigSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        runtimeConfigDefaults,
        defaultData ?? (entity ? runtimeConfigToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: RuntimeConfigFormValues) => {
      const current = requireContext(context)
      if (!entity) throw new Error("Session is missing.")
      return controlApi.updateSessionRuntimeConfig(
        current.agentKey,
        entity.id,
        runtimeConfigPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Runtime defaults updated")
      setOpen(false)
      await invalidate(
        context?.agentKey && entity
          ? controlKeys.agents.session(context.agentKey, entity.id)
          : agentCacheKey(context?.agentKey)
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: runtimeConfigSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      title="Runtime Defaults"
      description="Set the model and thinking defaults for this durable session."
    >
      <form.AppField name="model">
        {(field) => (
          <field.TextField
            label="Model"
            description="Optional model selector. Leave blank to use the system default."
            autoFocus
          />
        )}
      </form.AppField>
      <form.AppField name="thinking">
        {(field) => (
          <field.SelectField
            label="Thinking"
            description="Default inherits runtime or subagent behavior. Off explicitly disables thinking for this session."
            options={thinkingOptions}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionBriefingSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } = useBriefingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        briefingDefaults,
        defaultData ?? (entity ? briefingToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: BriefingFormValues) => {
      const current = requireContext(context)
      if (!current.sessionId) throw new Error("Session is missing.")
      return controlApi.setBriefing(
        current.agentKey,
        current.sessionId,
        briefingPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Briefing saved")
      setOpen(false)
      await invalidate(
        context?.agentKey && context.sessionId
          ? controlKeys.agents.session(context.agentKey, context.sessionId)
          : agentCacheKey(context?.agentKey)
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: briefingSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Update briefing",
        description: "This changes durable context for the current session.",
        confirmLabel: "Update briefing",
      }}
      description="Edit the durable briefing this session carries into future work."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Update"
      title="Session Briefing"
    >
      <form.AppField name="content">
        {(field) => (
          <field.TextareaField
            label="Briefing"
            description="Operator-owned context, preferences, constraints, and durable instructions for this session."
            className="min-h-80 font-mono text-xs leading-relaxed"
            placeholder="Add the session context the agent should keep using."
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionScheduledTaskSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useScheduledTaskSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const isUpdate = Boolean(entity)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        scheduledTaskDefaults(),
        defaultData ?? (entity ? scheduledTaskToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const schema = React.useMemo(() => scheduledTaskSchema(!isUpdate), [isUpdate])
  const mutation = useMutation({
    mutationFn: (values: ScheduledTaskFormValues) => {
      const current = requireContext(context)
      if (!current.sessionId) throw new Error("Session is missing.")
      if (entity) {
        return controlApi.updateScheduledTask(
          current.agentKey,
          current.sessionId,
          entity.id,
          scheduledTaskPayload(values, "update"),
          auth.csrfToken
        )
      }
      return controlApi.createScheduledTask(
        current.agentKey,
        current.sessionId,
        scheduledTaskPayload(values, "create"),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success(isUpdate ? "Automation updated" : "Automation created")
      setOpen(false)
      await invalidate(
        context?.agentKey && context.sessionId
          ? controlKeys.sessions.scheduledTasks(context.agentKey, context.sessionId)
          : agentCacheKey(context?.agentKey)
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: isUpdate ? "Update automation" : "Create automation",
        description: isUpdate
          ? "This changes future scheduled wakeups for this session."
          : "This creates a scheduled wakeup for this session.",
        confirmLabel: isUpdate ? "Update automation" : "Create automation",
      }}
      description={
        isUpdate
          ? "Leave instruction blank to keep the current private instruction."
          : "Create a scheduled automation for the current session."
      }
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel={isUpdate ? "Update" : "Create"}
      title="Automation"
    >
      <form.AppField name="title">
        {(field) => <field.TextField label="Title" autoFocus required />}
      </form.AppField>
      <form.AppField name="enabled">
        {(field) => (
          <field.SwitchField
            label="Enabled"
            description="Disabled automations stay configured but will not wake the session."
            required
          />
        )}
      </form.AppField>
      <form.AppField name="scheduleKind">
        {(field) => (
          <field.SelectField
            label="Schedule"
            options={scheduleKindOptions}
            required
          />
        )}
      </form.AppField>
      <form.Subscribe selector={(state: { values: ScheduledTaskFormValues }) => state.values.scheduleKind}>
        {(scheduleKind: ScheduledTaskFormValues["scheduleKind"]) =>
          scheduleKind === "once" ? (
            <form.AppField name="runAt">
              {(field) => (
                <field.TextField
                  label="Run at"
                  type="datetime-local"
                  required
                />
              )}
            </form.AppField>
          ) : (
            <>
              <form.AppField name="cron">
                {(field) => (
                  <field.TextField
                    label="Cron"
                    description="Use a five-field cron expression."
                    placeholder="0 9 * * *"
                    required
                  />
                )}
              </form.AppField>
              <form.AppField name="timezone">
                {(field) => (
                  <field.TextField
                    label="Timezone"
                    placeholder="Europe/Bratislava"
                    required
                  />
                )}
              </form.AppField>
            </>
          )
        }
      </form.Subscribe>
      <form.AppField name="instruction">
        {(field) => (
          <field.TextareaField
            label="Instruction"
            description={
              isUpdate
                ? "Optional. Enter a new private instruction only when replacing the current one."
                : "Private prompt the agent receives when this automation fires."
            }
            className="min-h-36"
            required={!isUpdate}
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionHeartbeatConfigSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useHeartbeatConfigSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        heartbeatConfigDefaults,
        defaultData ?? (entity ? heartbeatConfigToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: HeartbeatConfigFormValues) => {
      const current = requireContext(context)
      if (!current.sessionId) throw new Error("Session is missing.")
      return controlApi.updateHeartbeat(
        current.agentKey,
        current.sessionId,
        heartbeatConfigPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Wake policy updated")
      setOpen(false)
      await invalidate(
        context?.agentKey && context.sessionId
          ? controlKeys.sessions.heartbeat(context.agentKey, context.sessionId)
          : agentCacheKey(context?.agentKey)
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: heartbeatConfigSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Update wake policy",
        description: "This changes heartbeat wakeups for the current session.",
        confirmLabel: "Update wake policy",
      }}
      description="Configure whether this session receives heartbeat wakeups and how often."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Update"
      title="Wake Policy"
    >
      <form.AppField name="enabled">
        {(field) => (
          <field.SwitchField
            label="Heartbeat enabled"
            description="Keep this on only for durable sessions that should stay present over time."
            required
          />
        )}
      </form.AppField>
      <form.AppField name="everyMinutes">
        {(field) => (
          <field.TextField
            label="Cadence"
            description="Minimum allowed cadence is 15 minutes."
            type="number"
            inputMode="numeric"
            min={15}
            step={1}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionA2ABindingSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } = useA2ABindingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(a2aBindingDefaults, defaultData),
    [defaultData]
  )
  const sessionOptions = useSessionOptions(context, isOpen, resetValues.recipientSessionId)
  const recipientOptions = React.useMemo(
    () =>
      sessionOptions.options.filter(
        (option) => option.value !== context?.sessionId
      ),
    [context?.sessionId, sessionOptions.options]
  )
  const mutation = useMutation({
    mutationFn: (values: A2ABindingFormValues) => {
      const current = requireContext(context)
      if (!current.sessionId) throw new Error("Session is missing.")
      return controlApi.bindA2ASession(
        current.agentKey,
        current.sessionId,
        a2aBindingPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("A2A binding created")
      setOpen(false)
      await invalidate(
        context?.agentKey && context.sessionId
          ? controlKeys.agents.session(context.agentKey, context.sessionId)
          : agentCacheKey(context?.agentKey)
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: a2aBindingSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Bind A2A session",
        description:
          "This allows the current session to message the selected session directly. By default, the reverse route is created too.",
        confirmLabel: "Bind sessions",
      }}
      description="Allow this session to message another visible session directly."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Bind"
      title="A2A Binding"
    >
      <form.AppField name="recipientSessionId">
        {(field) => (
          <field.ComboboxField
            label="Recipient session"
            description="Pick another visible session. The current session is excluded."
            disabled={sessionOptions.isLoading}
            options={recipientOptions}
            placeholder={
              sessionOptions.isLoading ? "Loading sessions" : "Select session"
            }
            required
          />
        )}
      </form.AppField>
      <form.AppField name="oneWay">
        {(field) => (
          <field.SwitchField
            label="One-way only"
            description="Leave off for a reciprocal binding. Turn on only when the selected session should not message this one back."
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SessionWatchConfigSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useWatchConfigSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        watchConfigDefaults,
        defaultData ?? (entity ? watchConfigToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: WatchConfigFormValues) => {
      const current = requireContext(context)
      if (!current.sessionId || !entity) throw new Error("Watch is missing.")
      return controlApi.updateWatch(
        current.agentKey,
        current.sessionId,
        entity.id,
        watchConfigPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Watch config updated")
      setOpen(false)
      await invalidate(
        context?.agentKey && context.sessionId
          ? controlKeys.sessions.watches(context.agentKey, context.sessionId)
          : agentCacheKey(context?.agentKey)
      )
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: watchConfigSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Update watch",
        description: "This changes the watch label, polling interval, or enabled state for this session.",
        confirmLabel: "Update watch",
      }}
      description="Control can edit visible watch metadata and cadence. Private source and detector config stay hidden."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Update"
      title="Watch Config"
    >
      <form.AppField name="title">
        {(field) => <field.TextField label="Title" autoFocus required />}
      </form.AppField>
      <form.AppField name="enabled">
        {(field) => (
          <field.SwitchField
            label="Enabled"
            description="Disabled watches remain configured but will not poll."
            required
          />
        )}
      </form.AppField>
      <form.AppField name="intervalMinutes">
        {(field) => (
          <field.TextField
            label="Interval"
            description="Polling interval in minutes."
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}
