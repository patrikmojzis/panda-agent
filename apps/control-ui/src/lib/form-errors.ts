import { toast } from "sonner"

import { ApiError } from "@/lib/api"

type FormErrorApi = {
  setErrorMap: (errorMap: {
    onSubmit: {
      fields: Record<string, { message: string }>
    }
  }) => void
}

type PydanticErrorBody = {
  data?: Array<{
    loc: Array<string | number>
    msg: string
  }>
}

type FieldErrorBody = {
  errors?: Array<{
    field?: string
    message?: string
  }>
}

type ControlFormErrorOptions = {
  fieldMap?: Record<string, string>
  messageFieldMap?: Record<string, string | string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function bodyMessage(body: unknown) {
  return isRecord(body) && typeof body.error === "string" ? body.error : undefined
}

function pydanticLocToField(loc: Array<string | number>): string {
  return loc
    .filter((part) => part !== "body" && part !== "query" && part !== "path")
    .reduce<string>((path, part) => {
      if (typeof part === "number" || /^\d+$/.test(String(part))) return `${path}[${part}]`
      const key = String(part)
      return path ? `${path}.${key}` : key
    }, "")
}

function mapField(field: string, options?: ControlFormErrorOptions) {
  return options?.fieldMap?.[field] ?? field
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

function applyStructuredErrors(
  formApi: FormErrorApi,
  body: unknown,
  options?: ControlFormErrorOptions
) {
  const fields: Record<string, string> = {}
  const pydantic = body as PydanticErrorBody
  for (const error of pydantic.data ?? []) {
    const field = mapField(pydanticLocToField(error.loc), options)
    if (field && !fields[field]) fields[field] = error.msg
  }

  const fieldErrors = body as FieldErrorBody
  for (const error of fieldErrors.errors ?? []) {
    if (!error.field || !error.message) continue
    const field = mapField(error.field, options)
    if (field && !fields[field]) fields[field] = error.message
  }

  if (Object.keys(fields).length === 0) return false
  setFormErrors(formApi, fields)
  return true
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

  if (applyStructuredErrors(formApi, error.body, options)) return

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
