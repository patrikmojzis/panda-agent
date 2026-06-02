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
import { credentialDefaults } from "@/features/control/forms/form-values"
import { credentialPayload } from "@/features/control/forms/form-payloads"
import {
  useCredentialSheet,
  type CredentialFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const credentialSchema = z.object({
  envKey: z.string().trim().min(1, "Environment key is required."),
  value: z.string().min(1, "Secret value is required."),
})

export function CredentialSheet() {
  const auth = useAuth()
  const { context, defaultData, entity, isOpen, setOpen } =
    useCredentialSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () =>
      mergedValues(credentialDefaults, {
        ...defaultData,
        envKey: defaultData?.envKey ?? entity?.envKey ?? "",
        value: "",
      }),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: CredentialFormValues) => {
      const current = requireContext(context)
      return controlApi.setCredential(
        current.agentKey,
        credentialPayload(values),
        auth.csrfToken
      )
    },
    onError: formError,
    onSuccess: async () => {
      toast.success("Credential stored")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: credentialSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Update credential" : "Store credential",
        description:
          "This writes a secret value for the visible agent. Control will not show the stored value again.",
        confirmLabel: entity ? "Update credential" : "Store credential",
      }}
      description="Stored secret values are write-only and never re-rendered."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel="Store"
      title={entity ? "Update Credential" : "Store Credential"}
    >
      <form.AppField name="envKey">
        {(field) => (
          <field.TextField
            label="Environment key"
            autoComplete="off"
            autoFocus={!entity}
            disabled={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
      <form.AppField name="value">
        {(field) => (
          <field.TextField
            label="Secret value"
            autoComplete="new-password"
            type="password"
            autoFocus={Boolean(entity)}
            required
          />
        )}
      </form.AppField>
    </FormSheet>
  )
}
