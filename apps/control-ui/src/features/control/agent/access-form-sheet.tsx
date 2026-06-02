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
import { useIdentityOptions } from "@/features/control/forms/form-options"
import { agentPairingPayload } from "@/features/control/forms/form-payloads"
import { agentPairingDefaults } from "@/features/control/forms/form-values"
import {
  useAgentPairingSheet,
  type AgentPairingFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { handleControlFormError } from "@/lib/form-errors"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const agentPairingSchema = z.object({
  identityId: z.string().trim().min(1, "Identity is required."),
})

const agentPairingErrorFields = {
  identity: "identityId",
  "identity id": "identityId",
  "identity was not found": "identityId",
}

export function AgentPairingSheet() {
  const auth = useAuth()
  const { context, defaultData, isOpen, setOpen } = useAgentPairingSheet()
  const invalidate = useInvalidateAgent(context?.agentKey)
  const resetValues = React.useMemo(
    () => mergedValues(agentPairingDefaults, defaultData),
    [defaultData]
  )
  const identityPicker = useIdentityOptions(isOpen, resetValues.identityId)
  const mutation = useMutation({
    mutationFn: (values: AgentPairingFormValues) => {
      const current = requireContext(context)
      return controlApi.pairAgentIdentity(
        current.agentKey,
        agentPairingPayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success("Identity paired")
      setOpen(false)
      await invalidate(agentCacheKey(context?.agentKey))
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: agentPairingSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: agentPairingErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: "Pair identity",
        description:
          "This pairs an existing identity with the agent so scoped access and channel actor routing can reach it.",
        confirmLabel: "Pair identity",
      }}
      description="Pair an existing active identity with this agent."
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitDisabled={
        identityPicker.isLoading || identityPicker.options.length === 0
      }
      submitLabel="Pair identity"
      title="Pair Identity"
    >
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
