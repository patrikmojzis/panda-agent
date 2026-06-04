import * as React from "react"
import type { ColumnFiltersState, PaginationState, SortingState, Updater, VisibilityState } from "@tanstack/react-table"
import { create, type StoreApi, type UseBoundStore } from "zustand"
import { persist } from "zustand/middleware"

import type { TableParams } from "@/lib/api"
import {
  tableFiltersToParams,
  type DataTableFilterValueSetters,
  type DataTableGlobalFilter,
} from "@/components/common/data-table/hooks/filter-params"

type StoredDataTableState = {
  sorting: SortingState
  setSorting: (updater: Updater<SortingState>) => void
  columnFilters: ColumnFiltersState
  setColumnFilters: (updater: Updater<ColumnFiltersState>) => void
  columnVisibility: VisibilityState
  setColumnVisibility: (updater: Updater<VisibilityState>) => void
  pagination: PaginationState
  setPagination: (updater: Updater<PaginationState>) => void
  globalFilter: DataTableGlobalFilter
  setGlobalFilter: (updater: Updater<DataTableGlobalFilter>) => void
}

export type DataTableState = StoredDataTableState & {
  params: TableParams
}

type DataTableInitialState = Partial<
  Pick<TableParams, "page" | "per_page" | "search" | "sort_by" | "sort_direction">
> & {
  columnFilters?: ColumnFiltersState
  columnVisibility?: VisibilityState
  filterValueSetters?: DataTableFilterValueSetters
}

type DataTableStore = UseBoundStore<StoreApi<StoredDataTableState>>

const tableStores = new Map<string, DataTableStore>()

function resolveUpdater<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === "function" ? (updater as (old: T) => T)(previous) : updater
}

function initialSorting(initial?: DataTableInitialState): SortingState {
  if (!initial?.sort_by) return []
  return [{ id: initial.sort_by, desc: initial.sort_direction === "desc" }]
}

function createDataTableStore(tableKey: string, initial?: DataTableInitialState): DataTableStore {
  return create<StoredDataTableState>()(
    persist(
      (set) => ({
        sorting: initialSorting(initial),
        columnFilters: initial?.columnFilters ?? [],
        columnVisibility: initial?.columnVisibility ?? {},
        pagination: {
          pageIndex: Math.max((initial?.page ?? 1) - 1, 0),
          pageSize: initial?.per_page ?? 25,
        },
        globalFilter: { search: initial?.search ?? "" },
        setSorting: (updater) => set((state) => ({ sorting: resolveUpdater(updater, state.sorting) })),
        setColumnFilters: (updater) => set((state) => ({ columnFilters: resolveUpdater(updater, state.columnFilters) })),
        setColumnVisibility: (updater) => set((state) => ({ columnVisibility: resolveUpdater(updater, state.columnVisibility) })),
        setPagination: (updater) => set((state) => ({ pagination: resolveUpdater(updater, state.pagination) })),
        setGlobalFilter: (updater) => set((state) => ({ globalFilter: resolveUpdater(updater, state.globalFilter) })),
      }),
      {
        name: `control-ui:table:${tableKey}`,
        partialize: (state) => ({
          columnVisibility: state.columnVisibility,
        }),
        merge: (persisted, current) => ({
          ...current,
          columnVisibility:
            {
              ...current.columnVisibility,
              ...((persisted as Partial<StoredDataTableState> | undefined)
                ?.columnVisibility ?? {}),
            },
        }),
      }
    )
  )
}

function getDataTableStore(tableKey: string, initial?: DataTableInitialState) {
  const existing = tableStores.get(tableKey)
  if (existing) return existing

  const store = createDataTableStore(tableKey, initial)
  tableStores.set(tableKey, store)
  return store
}

export function useDataTableState(tableKey: string, initial?: DataTableInitialState): DataTableState {
  const store = React.useMemo(() => getDataTableStore(tableKey, initial), [tableKey, initial])
  const sorting = store((state) => state.sorting)
  const setSorting = store((state) => state.setSorting)
  const columnFilters = store((state) => state.columnFilters)
  const setColumnFilters = store((state) => state.setColumnFilters)
  const columnVisibility = store((state) => state.columnVisibility)
  const setColumnVisibility = store((state) => state.setColumnVisibility)
  const pagination = store((state) => state.pagination)
  const setPagination = store((state) => state.setPagination)
  const globalFilter = store((state) => state.globalFilter)
  const setGlobalFilter = store((state) => state.setGlobalFilter)

  const params = React.useMemo<TableParams>(
    () => ({
      page: pagination.pageIndex + 1,
      per_page: pagination.pageSize,
      search: globalFilter.search,
      sort_by: sorting[0]?.id,
      sort_direction: sorting[0] ? (sorting[0].desc ? "desc" : "asc") : undefined,
      ...tableFiltersToParams({
        columnFilters,
        filterValueSetters: initial?.filterValueSetters,
        globalFilter,
      }),
    }),
    [
      columnFilters,
      globalFilter,
      initial?.filterValueSetters,
      pagination.pageIndex,
      pagination.pageSize,
      sorting,
    ]
  )

  return {
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
    params,
  }
}
