import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Copy, KeyRound } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"

import { FormSheet } from "@/components/common/form/form-sheet"
import { useControlForm } from "@/components/common/form/use-control-form"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useAgentOptions, useIdentityOptions } from "@/features/control/forms/form-options"
import { controlGrantPayload } from "@/features/control/forms/form-payloads"
import { controlGrantDefaults } from "@/features/control/forms/form-values"
import { mergedValues } from "@/features/control/forms/form-sheet-shared"
import {
  useControlGrantSheet,
  type ControlGrantFormValues,
} from "@/features/control/forms/use-control-form-sheets"
import { formatDate } from "@/features/control/formatting"
import { handleControlFormError } from "@/lib/form-errors"
import { controlApi, type ControlGrant } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const controlGrantSchema = z
  .object({
    agentKey: z.string(),
    identityId: z.string().trim().min(1, "Identity is required."),
    label: z.string(),
    role: z.enum(["admin", "scoped"]),
  })
  .superRefine((value, context) => {
    if (value.role === "scoped" && !value.agentKey.trim()) {
      context.addIssue({
        code: "custom",
        message: "Agent is required for scoped grants.",
        path: ["agentKey"],
      })
    }
  })

type IssuedGrant = {
  grant: ControlGrant
  loginToken: string
}

export function ControlGrantSheet() {
  const auth = useAuth()
  const { defaultData, isOpen, setOpen } = useControlGrantSheet()
  const [issued, setIssued] = React.useState<IssuedGrant | null>(null)
  const resetValues = React.useMemo(
    () => mergedValues(controlGrantDefaults, defaultData),
    [defaultData]
  )
  const identityPicker = useIdentityOptions(isOpen, resetValues.identityId)
  const agentPicker = useAgentOptions(isOpen, resetValues.agentKey)
  const mutation = useMutation({
    mutationFn: (values: ControlGrantFormValues) =>
      controlApi.issueControlGrant(controlGrantPayload(values), auth.csrfToken),
    onSuccess: (result) => {
      toast.success("Control login token issued")
      setIssued(result)
      setOpen(false)
    },
  })
  const form = useControlForm({
    defaultValues: resetValues,
    validators: { onSubmit: controlGrantSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value)
      } catch (error) {
        await handleControlFormError(error, formApi)
      }
    },
  })

  return (
    <>
      <FormSheet
        confirmSubmit={{
          title: "Issue Control login token",
          description:
            "This creates a one-time login token. It will be shown once after the grant is created.",
          confirmLabel: "Issue token",
        }}
        description="Create a one-time operator login token for an identity."
        form={form}
        isOpen={isOpen}
        resetValues={resetValues}
        setIsOpen={(open) => setOpen(open)}
        submitDisabled={
          identityPicker.isLoading ||
          identityPicker.options.length === 0 ||
          agentPicker.isLoading
        }
        submitLabel="Issue token"
        title="Issue Control token"
      >
        <form.AppField name="identityId">
          {(field) => (
            <field.ComboboxField
              label="Identity"
              disabled={identityPicker.isLoading || identityPicker.options.length === 0}
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
        <form.AppField name="role">
          {(field) => (
            <field.SelectField
              label="Role"
              description="Scoped grants require an agent and stay limited to that agent. Admin grants can operate across Control."
              options={[
                { label: "Scoped", value: "scoped" },
                { label: "Admin", value: "admin" },
              ]}
              required
            />
          )}
        </form.AppField>
        <form.Subscribe selector={(state: { values: ControlGrantFormValues }) => state.values.role}>
          {(role: ControlGrantFormValues["role"]) =>
            role === "scoped" ? (
              <form.AppField name="agentKey">
                {(field) => (
                  <field.ComboboxField
                    label="Agent"
                    disabled={agentPicker.isLoading || agentPicker.options.length === 0}
                    options={agentPicker.options}
                    placeholder={
                      agentPicker.isLoading
                        ? "Loading agents"
                        : agentPicker.options.length === 0
                          ? "No agents"
                          : "Select agent"
                    }
                    required
                  />
                )}
              </form.AppField>
            ) : null
          }
        </form.Subscribe>
        <form.AppField name="label">
          {(field) => (
            <field.TextField
              label="Label"
              placeholder="Laptop setup, contractor access"
            />
          )}
        </form.AppField>
      </FormSheet>
      <IssuedGrantDialog issued={issued} onOpenChange={(open) => !open && setIssued(null)} />
    </>
  )
}

function IssuedGrantDialog({
  issued,
  onOpenChange,
}: {
  issued: IssuedGrant | null
  onOpenChange: (open: boolean) => void
}) {
  const token = issued?.loginToken ?? ""

  async function copyToken() {
    if (!token) return
    await navigator.clipboard.writeText(token)
    toast.success("Login token copied")
  }

  return (
    <Dialog open={Boolean(issued)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Control login token issued</DialogTitle>
          <DialogDescription>
            Copy this token now. Control will not show it again.
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <KeyRound className="size-4" />
          <AlertTitle>One-time token</AlertTitle>
          <AlertDescription>
            The token expires {issued ? formatDate(issued.grant.loginTokenExpiresAt) : "-"} and is consumed on login.
          </AlertDescription>
        </Alert>
        <div className="grid gap-2">
          <label className="text-xs font-medium" htmlFor="issued-control-token">
            Login token
          </label>
          <Input
            id="issued-control-token"
            readOnly
            value={token}
            className="font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={() => void copyToken()}>
            <Copy className="size-4" />
            Copy token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
