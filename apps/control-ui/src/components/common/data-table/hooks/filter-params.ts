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

export type DataTableFilterValueSetter = (
  value: unknown,
  key: string
) => unknown

export type DataTableFilterValueSetters = Partial<
  Record<string, DataTableFilterValueSetter>
>

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
