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
import { wikiBindingPayload } from "@/features/control/forms/form-payloads"
import {
  wikiBindingDefaults,
  wikiBindingToFormValues,
} from "@/features/control/forms/form-values"
import {
  useWikiBindingSheet,
  type WikiBindingFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const wikiBindingSchema = z.object({
  apiToken: z.string().min(1, "Wiki API token is required."),
  namespacePath: z.string().trim().min(1, "Namespace path is required."),
  wikiGroupId: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, "Wiki group id must be a positive integer."),
})

export function WikiBindingSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useWikiBindingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        wikiBindingDefaults,
        defaultData ?? (entity ? wikiBindingToFormValues(entity) : undefined)
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: WikiBindingFormValues) => {
      const current = requireContext(context)
      return controlApi.setWikiBinding(
        current.agentKey,
        wikiBindingPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Wiki binding saved")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: wikiBindingSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Update Wiki binding" : "Store Wiki binding",
        description:
          "This stores a Wiki.js API token for the visible agent. Control will not show the token again.",
        confirmLabel: entity ? "Update binding" : "Store binding",
      }}
      description="Bind this agent to a Wiki.js group and namespace. The API token is write-only."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel={entity ? "Update binding" : "Store binding"}
      title={entity ? "Update Wiki binding" : "Wiki binding"}
    >
      <form.AppField name="wikiGroupId">
        {(field) => (
          <field.TextField
            label="Wiki group id"
            autoComplete="off"
            autoFocus
            inputMode="numeric"
            placeholder="7"
            required
          />
        )}
      </form.AppField>
      <form.AppField name="namespacePath">
        {(field) => (
          <field.TextField
            label="Namespace path"
            autoComplete="off"
            placeholder="agents/panda"
            required
          />
        )}
      </form.AppField>
      <form.AppField name="apiToken">
        {(field) => (
          <field.TextField
            label="API token"
            autoComplete="new-password"
            description="Stored tokens are write-only. Paste a fresh token when saving changes."
            type="password"
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}
