import type { Table } from "@tanstack/react-table"

function hasActiveValues(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  return Object.values(value).some((item) => {
    if (Array.isArray(item)) return item.length > 0
    return item !== null && item !== undefined && item !== ""
  })
}

export function hasActiveTableFilters<TData>(table: Table<TData>): boolean {
  const { columnFilters, globalFilter } = table.getState()
  return columnFilters.length > 0 || hasActiveValues(globalFilter)
}

export function resetTableFilters<TData>(table: Table<TData>): void {
  table.setColumnFilters([])
  table.setGlobalFilter({})
}
