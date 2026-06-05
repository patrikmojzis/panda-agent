import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
import { useSkillDetail, useSubagentDetail } from "@/features/control/api/queries"
import {
  agentCacheKey,
  formError,
  mergedValues,
  requireContext,
  useInvalidateAgent,
} from "@/features/control/forms/form-sheet-shared"
import {
  skillDefaults,
  skillToFormValues,
  subagentDefaults,
  subagentToFormValues,
} from "@/features/control/forms/form-values"
import {
  skillPayload,
  subagentPayload,
} from "@/features/control/forms/form-payloads"
import {
  useSkillSheet,
  useSubagentSheet,
  type SkillFormValues,
  type SubagentFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { subagentToolGroupOptions } from "@/features/control/agent/subagent-options"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const skillSchema = z.object({
  content: z.string().min(1, "Skill content is required."),
  description: z.string().trim().min(1, "Description is required."),
  skillKey: z.string().trim().min(1, "Skill key is required."),
  tags: z.string(),
})

const subagentSchema = z.object({
  description: z.string().trim().min(1, "Description is required."),
  model: z.string(),
  prompt: z.string().min(1, "Prompt is required."),
  slug: z.string().trim().min(1, "Slug is required."),
  thinking: z.string(),
  toolGroups: z.array(z.string()).min(1, "At least one tool group is required."),
})

export function SkillSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } = useSkillSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const skill = useSkillDetail(context?.agentKey ?? "", entity?.skillKey ?? "", {
    enabled: Boolean(isOpen && context?.agentKey && entity?.skillKey),
  })
  const loadedSkill = skill.data?.skill
  const entitySkillValues = React.useMemo(
    () => (entity ? skillToFormValues(entity) : undefined),
    [entity]
  )
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        skillDefaults,
        loadedSkill ? skillToFormValues(loadedSkill) : defaultData ?? entitySkillValues
      ),
    [defaultData, entitySkillValues, loadedSkill]
  )
  const mutation = useMutation({
    mutationFn: (values: SkillFormValues) => {
      const current = requireContext(context)
      return controlApi.setSkill(
        current.agentKey,
        skillPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Skill saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: skillSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      description="Define agent-owned reusable instruction content."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      title={entity ? "Edit Skill" : "Skill"}
    >
      <form.AppField name="skillKey">
        {(field) => (
          <field.TextField
            label="Skill key"
            autoComplete="off"
            autoFocus={!entity}
            disabled={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="description">
        {(field) => (
          <field.TextField
            label="Description"
            autoFocus={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="tags">
        {(field) => (
          <field.TextareaField
            label="Tags"
            className="min-h-20 font-mono text-xs"
            description="Optional discovery tags separated by commas or new lines. Example: coding, repo:panda-agent, ui-ux"
            placeholder="coding, repo:panda-agent"
          />
        )}
      </form.AppField>
      <form.AppField name="content">
        {(field) => (
          <field.TextareaField
            label="Content"
            className="min-h-72 font-mono text-xs"
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}

export function SubagentSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } = useSubagentSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const subagent = useSubagentDetail(
    context?.agentKey ?? "",
    entity?.slug ?? "",
    {
      enabled: Boolean(isOpen && context?.agentKey && entity?.slug),
    }
  )
  const loadedSubagent = subagent.data?.subagent
  const entitySubagentValues = React.useMemo(
    () => (entity ? subagentToFormValues(entity) : undefined),
    [entity]
  )
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        subagentDefaults,
        loadedSubagent
          ? subagentToFormValues(loadedSubagent)
          : defaultData ?? entitySubagentValues
      ),
    [defaultData, entitySubagentValues, loadedSubagent]
  )
  const mutation = useMutation({
    mutationFn: (values: SubagentFormValues) => {
      const current = requireContext(context)
      return controlApi.setSubagent(
        current.agentKey,
        subagentPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Subagent saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: subagentSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      description="Configure a named agent-owned subagent profile."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      title={entity ? "Edit Subagent" : "Subagent Profile"}
    >
      <form.AppField name="slug">
        {(field) => (
          <field.TextField
            label="Slug"
            autoComplete="off"
            autoFocus={!entity}
            disabled={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="description">
        {(field) => (
          <field.TextField
            label="Description"
            autoFocus={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <div className="grid gap-3 rounded-md border p-3">
        <div className="text-sm font-medium">Runtime access</div>
        <form.AppField name="toolGroups">
          {(field) => (
          <field.MultiSelectField
            label="Tool groups"
              options={subagentToolGroupOptions}
              required
            />
          )}
        </form.AppField>
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="model">
            {(field) => <field.TextField label="Model" autoComplete="off" />}
          </form.AppField>
          <form.AppField name="thinking">
            {(field) => <field.TextField label="Thinking" autoComplete="off" />}
          </form.AppField>
        </div>
      </div>
      <form.AppField name="prompt">
        {(field) => (
          <field.TextareaField
            label="Prompt"
            className="min-h-72 font-mono text-xs"
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}
