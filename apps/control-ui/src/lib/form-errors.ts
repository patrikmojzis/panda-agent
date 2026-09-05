import { toast } from "sonner"

import { ApiError } from "./api"

type FormErrorApi = {
  setErrorMap: (errorMap: {
    onSubmit: {
      fields: Record<string, { message: string }>
    }
  }) => void
}

type ControlFormErrorOptions = {
  messageFieldMap?: Record<string, string | string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function bodyMessage(body: unknown) {
  return isRecord(body) && typeof body.error === "string" ? body.error : undefined
}

function setFormErrors(formApi: FormErrorApi, fields: Record<string, string>) {
  formApi.setErrorMap({
    onSubmit: {
      fields: Object.fromEntries(
        Object.entries(fields).map(([field, message]) => [field, { message }])
      ),
    },
  })
}

function applyMessageError(
  formApi: FormErrorApi,
  message: string,
  options?: ControlFormErrorOptions
) {
  const normalized = message.toLowerCase()
  const fields: Record<string, string> = {}

  for (const [needle, targets] of Object.entries(options?.messageFieldMap ?? {})) {
    if (!normalized.includes(needle.toLowerCase())) continue
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      if (!fields[target]) fields[target] = message
    }
  }

  if (Object.keys(fields).length === 0) return false
  setFormErrors(formApi, fields)
  return true
}

export async function handleControlFormError(
  error: unknown,
  formApi: FormErrorApi,
  options?: ControlFormErrorOptions
) {
  if (!(error instanceof ApiError)) {
    toast.error(error instanceof Error ? error.message : "Control write failed")
    return
  }

  const message = bodyMessage(error.body) ?? error.message
  if (applyMessageError(formApi, message, options)) return

  if (error.status === 403) {
    toast.error("You do not have permission to write this resource.")
    return
  }
  if (error.status === 401) {
    toast.error("Your Control session expired. Sign in again.")
    return
  }

  toast.error(message || "Control write failed")
}
