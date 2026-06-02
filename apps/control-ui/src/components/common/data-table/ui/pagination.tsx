import type { Table } from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatNumber } from "@/features/control/formatting"

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 25, 50, 100]

function pageSizeOptions(currentPageSize: number) {
  return Array.from(new Set([...DEFAULT_PAGE_SIZE_OPTIONS, currentPageSize])).sort((left, right) => left - right)
}

function formatResultRange(pageIndex: number, pageSize: number, totalRows: number) {
  if (totalRows === 0) return "0 results"

  const lastPageIndex = Math.max(Math.ceil(totalRows / pageSize) - 1, 0)
  const visiblePageIndex = Math.min(pageIndex, lastPageIndex)
  const start = visiblePageIndex * pageSize + 1
  const end = Math.min(totalRows, (visiblePageIndex + 1) * pageSize)
  return `Showing ${formatNumber(start) ?? start}-${formatNumber(end) ?? end} of ${formatNumber(totalRows) ?? totalRows} ${totalRows === 1 ? "result" : "results"}`
}

export default function DataTablePagination<TData>({ table }: { table: Table<TData> }) {
  const pagination = table.getState().pagination
  const totalRows = table.getRowCount()
  const pageCount = Math.max(table.getPageCount(), 1)
  const currentPage = Math.min(pagination.pageIndex + 1, pageCount)

  function handlePageSizeChange(value: string) {
    table.setPagination({ pageIndex: 0, pageSize: Number(value) })
  }

  return (
    <div className="flex flex-col gap-2 px-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <span className="block truncate">{formatResultRange(pagination.pageIndex, pagination.pageSize, totalRows)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end sm:gap-4 lg:gap-8">
        <div className="flex items-center gap-2">
          <span className="hidden font-medium sm:block">Rows per page</span>
          <span className="font-medium sm:hidden">Rows</span>
          <Select value={String(pagination.pageSize)} onValueChange={handlePageSizeChange}>
            <SelectTrigger className="h-8 w-[72px] sm:w-[90px]" aria-label="Rows per page">
              <SelectValue>{pagination.pageSize}</SelectValue>
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions(pagination.pageSize).map((pageSize) => (
                <SelectItem key={pageSize} value={String(pageSize)}>
                  {pageSize}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="hidden items-center justify-center font-medium tabular-nums sm:flex">
          Page {currentPage} of {pageCount}
        </div>
        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          <Button variant="outline" size="icon" className="hidden size-8 lg:flex" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
            <span className="sr-only">Go to first page</span>
            <ChevronsLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft className="size-4" />
          </Button>
          <div className="font-medium tabular-nums sm:hidden">
            {currentPage} / {pageCount}
          </div>
          <Button variant="outline" size="icon" className="size-8" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            <span className="sr-only">Go to next page</span>
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            onClick={() => table.setPageIndex(Math.max(table.getPageCount() - 1, 0))}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to last page</span>
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
