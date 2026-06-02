import * as React from "react"
import type { ColumnDef, VisibilityState } from "@tanstack/react-table"
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react"

import ColumnsVisibilityMenu from "@/components/common/data-table/ui/columns-visibility-menu"
import DataTable, {
  type LinkResolver,
} from "@/components/common/data-table/ui/data-table"
import { DataTableContainer } from "@/components/common/data-table/ui/containers"
import FiltersResetButton from "@/components/common/data-table/ui/filters-reset-button"
import LoadingIndicator from "@/components/common/data-table/ui/loading-indicator"
import DataTablePagination from "@/components/common/data-table/ui/pagination"
import SearchFilter from "@/components/common/data-table/ui/search-filter"
import { useTable } from "@/components/common/data-table/hooks/use-table"
import type { DataTableState } from "@/components/common/data-table/hooks/use-data-table-state"
import { hasActiveTableFilters } from "@/components/common/data-table/ui/filter-state"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useIsMobile } from "@/hooks/use-mobile"
import type { PaginatedResponse } from "@/lib/api"

type DataTableViewProps<TData> = {
  columns: ColumnDef<TData>[]
  response?: PaginatedResponse<TData>
  state: DataTableState
  rowKey: (row: TData, index: number) => string
  defaultColumnVisibility?: VisibilityState
  mobileColumnVisibility?: VisibilityState
  emptyLabel?: string
  emptyDescription?: string
  emptyAction?: React.ReactNode
  error?: unknown
  filters?: React.ReactNode
  getLink?: LinkResolver<TData>
  isFetching?: boolean
  isLoading?: boolean
  isPlaceholderData?: boolean
  onRetry?: () => void | Promise<unknown>
  showColumns?: boolean
  showPagination?: boolean
  showSearch?: boolean
  toolbarActions?: React.ReactNode
}

export default function DataTableView<TData>({
  columns,
  response,
  state,
  rowKey,
  defaultColumnVisibility,
  mobileColumnVisibility,
  emptyLabel,
  emptyDescription,
  emptyAction,
  error,
  filters,
  getLink,
  isFetching = false,
  isLoading = false,
  isPlaceholderData = false,
  onRetry,
  showColumns = true,
  showPagination = true,
  showSearch = true,
  toolbarActions,
}: DataTableViewProps<TData>) {
  const isMobile = useIsMobile()
  const responsiveColumnVisibility = React.useMemo(
    () =>
      isMobile && mobileColumnVisibility
        ? { ...mobileColumnVisibility, ...state.columnVisibility }
        : state.columnVisibility,
    [isMobile, mobileColumnVisibility, state.columnVisibility]
  )
  const responsiveState = React.useMemo(
    () => ({
      ...state,
      columnVisibility: responsiveColumnVisibility,
    }),
    [responsiveColumnVisibility, state]
  )
  const columnVisibilityDefaults = isMobile
    ? (mobileColumnVisibility ?? defaultColumnVisibility)
    : defaultColumnVisibility
  const table = useTable({
    data: response,
    columns,
    getRowId: rowKey,
    ...responsiveState,
  })
  const hasData = Boolean(response?.data.length)
  const showError = Boolean(error && !hasData && !isLoading)
  const showFilterRail = Boolean(filters) || hasActiveTableFilters(table)
  const resolvedEmptyAction = emptyAction ?? toolbarActions

  return (
    <div className="min-w-0 space-y-3">
      {showSearch || showColumns || filters || toolbarActions ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {showSearch ? <SearchFilter table={table} /> : null}
            {showFilterRail ? (
              <div className="flex min-w-0 max-w-full flex-wrap gap-2">
                {filters}
                <FiltersResetButton table={table} />
              </div>
            ) : null}
          </div>
          {showColumns || toolbarActions ? (
            <div className="flex shrink-0 flex-wrap gap-2 sm:ml-auto sm:justify-end">
              {toolbarActions}
              {showColumns ? (
                <ColumnsVisibilityMenu
                  table={table}
                  defaultState={columnVisibilityDefaults}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <DataTableContainer>
        {showError ? (
          <DataTableErrorState error={error} onRetry={onRetry} />
        ) : (
          <DataTable
            table={table}
            isLoading={isLoading}
            getLink={getLink}
            emptyLabel={emptyLabel}
            emptyDescription={emptyDescription}
            emptyAction={resolvedEmptyAction}
          />
        )}
        <LoadingIndicator
          isFetching={isFetching}
          isLoading={isLoading}
          isPlaceholderData={isPlaceholderData}
          hasData={hasData}
        />
      </DataTableContainer>
      {showPagination && !showError ? (
        <DataTablePagination table={table} />
      ) : null}
    </div>
  )
}

function DataTableErrorState({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void | Promise<unknown>
}) {
  return (
    <Empty className="min-h-40 border-0 p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircleIcon className="size-4 text-destructive" />
        </EmptyMedia>
        <EmptyTitle>Could not load table</EmptyTitle>
        <EmptyDescription>{tableErrorMessage(error)}</EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onRetry()}
          >
            <RefreshCwIcon className="size-3.5" />
            Retry
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

function tableErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed."
}
