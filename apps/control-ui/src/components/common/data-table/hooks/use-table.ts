import * as React from "react"
import {
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table"

import type { DataTableState } from "@/components/common/data-table/hooks/use-data-table-state"
import type { PaginatedResponse } from "@/lib/api"

type TableProps<TData> = {
  data?: PaginatedResponse<TData>
  columns: ColumnDef<TData>[]
  getRowId: (row: TData, index: number) => string
} & DataTableState

function normalizeFilterValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => normalizeFilterValue(item, seen))

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>
    if (seen.has(objectValue)) return "__circular__"
    seen.add(objectValue)
    return Object.fromEntries(
      Object.entries(objectValue)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeFilterValue(nestedValue, seen)])
    )
  }

  return value
}

function areValuesEqual(left: unknown, right: unknown) {
  try {
    return JSON.stringify(normalizeFilterValue(left)) === JSON.stringify(normalizeFilterValue(right))
  } catch {
    return left === right
  }
}

function resolveUpdater<TValue>(updater: Updater<TValue>, previous: TValue): TValue {
  return typeof updater === "function" ? (updater as (old: TValue) => TValue)(previous) : updater
}

function resetToFirstPage(setPagination: DataTableState["setPagination"]) {
  setPagination((previous) => (previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }))
}

export function useTable<TData>({
  data,
  columns,
  getRowId,
  sorting,
  setSorting,
  columnFilters,
  setColumnFilters,
  columnVisibility,
  setColumnVisibility,
  pagination,
  setPagination,
  globalFilter,
  setGlobalFilter,
}: TableProps<TData>) {
  const handleColumnFiltersChange = React.useCallback(
    (updater: Updater<ColumnFiltersState>) => {
      setColumnFilters((previous) => {
        const next = resolveUpdater(updater, previous)
        if (!areValuesEqual(previous, next)) resetToFirstPage(setPagination)
        return next
      })
    },
    [setColumnFilters, setPagination]
  )
  const handleGlobalFilterChange = React.useCallback(
    (updater: Updater<DataTableState["globalFilter"]>) => {
      setGlobalFilter((previous) => {
        const next = resolveUpdater(updater, previous)
        if (!areValuesEqual(previous, next)) resetToFirstPage(setPagination)
        return next
      })
    },
    [setGlobalFilter, setPagination]
  )
  const handleSortingChange = React.useCallback(
    (updater: Updater<SortingState>) => {
      setSorting((previous) => {
        const next = resolveUpdater(updater, previous)
        if (!areValuesEqual(previous, next)) resetToFirstPage(setPagination)
        return next
      })
    },
    [setPagination, setSorting]
  )
  const tableData = React.useMemo(() => data?.data ?? [], [data])

  return useReactTable<TData>({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId,
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
    onSortingChange: handleSortingChange,
    onColumnFiltersChange: handleColumnFiltersChange,
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: handleGlobalFilterChange,
    pageCount: data?.meta.last_page ?? 0,
    rowCount: data?.meta.total ?? 0,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      pagination,
      globalFilter,
    },
  })
}
