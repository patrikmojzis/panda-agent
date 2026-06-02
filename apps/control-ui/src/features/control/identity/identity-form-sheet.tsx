import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
import { controlKeys } from "@/features/control/api/query-key-factory"
import {
  identityCreatePayload,
  identityUpdatePayload,
} from "@/features/control/forms/form-payloads"
import {
  identityDefaults,
  identityToFormValues,
} from "@/features/control/forms/form-values"
import { mergedValues } from "@/features/control/forms/form-sheet-shared"
import {
  useIdentitySheet,
  type IdentityFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { handleControlFormError } from "@/lib/form-errors"

const identitySchema = z.object({
  displayName: z.string().trim().min(1, "Display name is required."),
  handle: z
    .string()
    .trim()
    .min(1, "Handle is required.")
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/i,
      "Use letters, numbers, hyphens, or underscores."
    ),
  status: z.enum(["active", "deleted"]),
})

const identityErrorFields = {
  display_name: "displayName",
  "display name": "displayName",
  handle: "handle",
  status: "status",
}

export function IdentitySheet() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { defaultData, entity, isOpen, setOpen } = useIdentitySheet()
  const resetValues = React.useMemo(
    () =>
      mergedValues(
        identityDefaults,
        entity ? identityToFormValues(entity) : defaultData
      ),
    [defaultData, entity]
  )
  const mutation = useMutation({
    mutationFn: (values: IdentityFormValues) => {
      if (entity) {
        return controlApi.updateIdentity(
          entity.id,
          identityUpdatePayload(values),
          auth.csrfToken
        )
      }
      return controlApi.createIdentity(
        identityCreatePayload(values),
        auth.csrfToken
      )
    },
    onSuccess: async () => {
      toast.success(entity ? "Identity updated" : "Identity created")
      setOpen(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: controlKeys.identities.all() }),
        queryClient.invalidateQueries({ queryKey: controlKeys.agents.all() }),
      ])
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: identitySchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi, {
          messageFieldMap: identityErrorFields,
        })
      }
    },
  })

  return (
    <FormSheet
      confirmSubmit={{
        title: entity ? "Update identity" : "Create identity",
        description: entity
          ? "This changes the operator identity metadata used by Control and channel actor routing."
          : "This creates a new Panda identity that can be paired with visible agents.",
        confirmLabel: entity ? "Update identity" : "Create identity",
      }}
      description={
        entity
          ? "Edit identity display metadata and status."
          : "Create an identity before pairing it with agents or channel actors."
      }
      form={form}
      isOpen={isOpen}
      resetValues={resetValues}
      setIsOpen={(open) => setOpen(open)}
      submitLabel={entity ? "Update identity" : "Create identity"}
      title={entity ? "Edit Identity" : "Create Identity"}
    >
      <form.AppField name="handle">
        {(field) => (
          <field.TextField
            label="Handle"
            description={
              entity ? "Handles cannot be renamed from Control yet." : undefined
            }
            autoComplete="off"
            autoFocus={!entity}
            disabled={Boolean(entity)}
            placeholder="patrik"
            required
          />
        )}
      </form.AppField>
      <form.AppField name="displayName">
        {(field) => (
          <field.TextField
            label="Display name"
            autoComplete="off"
            autoFocus={Boolean(entity)}
            placeholder="Patrik"
            required
          />
        )}
      </form.AppField>
      {entity ? (
        <form.AppField name="status">
          {(field) => (
            <field.SelectField
              label="Status"
              options={[
                { label: "Active", value: "active" },
                { label: "Deleted", value: "deleted" },
              ]}
              required
            />
          )}
        </form.AppField>
      ) : null}
    </FormSheet>
  )
}
