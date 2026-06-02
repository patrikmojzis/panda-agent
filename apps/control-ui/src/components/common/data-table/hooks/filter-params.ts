import type { ColumnFiltersState } from "@tanstack/react-table"

import type {
  TableParams,
  TableParamPrimitive,
  TableParamValue,
} from "@/lib/api"

export type DataTableGlobalFilter = {
  search?: string
  [key: string]: TableParamValue
}

export type DataTableFilterPatch = {
  __kind: "patch"
  keepSource?: boolean
  set: Record<string, unknown>
  unset?: string[]
}

export type DataTableFilterValueSetter = (
  value: unknown,
  key: string
) => unknown | DataTableFilterPatch

export type DataTableFilterValueSetters = Partial<
  Record<string, DataTableFilterValueSetter>
>

export function filterPatch(
  set: Record<string, unknown>,
  options?: { keepSource?: boolean; unset?: string[] }
): DataTableFilterPatch {
  return {
    __kind: "patch",
    keepSource: options?.keepSource,
    set,
    unset: options?.unset,
  }
}

export function booleanFilterValueSetter(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

export function tableFiltersToParams({
  columnFilters,
  filterValueSetters,
  globalFilter,
}: {
  columnFilters: ColumnFiltersState
  filterValueSetters?: DataTableFilterValueSetters
  globalFilter?: DataTableGlobalFilter
}): TableParams {
  const params: TableParams = {}

  function applyEntry(key: string, value: unknown) {
    const setter = filterValueSetters?.[key]
    const output = setter ? setter(value, key) : value

    if (isFilterPatch(output)) {
      for (const [patchKey, patchValue] of Object.entries(output.set)) {
        setParam(params, patchKey, patchValue)
      }
      if (output.keepSource) setParam(params, key, value)
      else delete params[key]
      for (const unsetKey of output.unset ?? []) delete params[unsetKey]
      return
    }

    setParam(params, key, output)
  }

  for (const { id, value } of columnFilters) {
    applyEntry(id, value)
  }
  for (const [key, value] of Object.entries(globalFilter ?? {})) {
    applyEntry(key, value)
  }

  return params
}

function isFilterPatch(value: unknown): value is DataTableFilterPatch {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as DataTableFilterPatch).__kind === "patch"
  )
}

function setParam(params: TableParams, key: string, value: unknown) {
  const normalized = normalizeParamValue(value)
  if (normalized === undefined) delete params[key]
  else params[key] = normalized
}

function normalizeParamValue(value: unknown): TableParamValue {
  if (value === null || value === undefined || value === "") return undefined
  if (Array.isArray(value)) {
    const normalized = value
      .map(normalizeParamPrimitive)
      .filter((item): item is TableParamPrimitive => item !== undefined)
    return normalized.length > 0 ? normalized : undefined
  }
  return normalizeParamPrimitive(value)
}

function normalizeParamPrimitive(value: unknown): TableParamPrimitive | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "boolean") return value
  return undefined
}
