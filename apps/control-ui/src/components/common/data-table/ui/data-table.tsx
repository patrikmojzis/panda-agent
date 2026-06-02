import { flexRender, type Cell as TanstackCell, type Column, type Row, type Table as TanstackTable } from "@tanstack/react-table"
import type * as React from "react"
import { Link } from "react-router-dom"
import { InboxIcon, SearchXIcon } from "lucide-react"

import { getColumnAlign, getColumnValueClassName } from "@/components/common/data-table/ui/column-meta"
import { hasActiveTableFilters, resetTableFilters } from "@/components/common/data-table/ui/filter-state"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type LinkResolver<T> = (data: T) => string

type DataTableProps<TData> = {
  table: TanstackTable<TData>
  isLoading?: boolean
  getLink?: LinkResolver<TData>
  headerClassName?: string
  emptyLabel?: string
  emptyDescription?: string
  emptyAction?: React.ReactNode
  renderFooter?: () => React.ReactNode
}

export default function DataTable<TData>({
  table,
  isLoading,
  getLink,
  headerClassName,
  emptyLabel = "No results",
  emptyDescription,
  emptyAction,
  renderFooter,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows
  const visibleColumns = table.getVisibleLeafColumns()
  const hasActiveFilters = hasActiveTableFilters(table)

  return (
    <Table className="min-w-full">
      <TableHeader className={cn("sticky top-0 bg-muted", headerClassName)}>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const align = getColumnAlign(header.column.columnDef.meta)
              const isActionColumn = header.column.id === "actions"
              return (
                <TableHead
                  key={header.id}
                  className={cn(
                    "text-xs uppercase text-muted-foreground",
                    isActionColumn && "sticky right-0 z-20 w-10 min-w-10 border-l bg-muted",
                    align === "center" && "text-center",
                    align === "right" && "text-right"
                  )}
                >
                  {isActionColumn ? <span className="sr-only">Actions</span> : header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length > 0 ? (
          rows.map((row) => (
            <TableRow key={row.id} data-state={row.getIsSelected() && "selected"} className="group">
              {row.getVisibleCells().map((cell) => (
                <LinkedCell key={cell.id} cell={cell} row={row} getLink={getLink} />
              ))}
            </TableRow>
          ))
        ) : isLoading ? (
          <SkeletonRows columns={visibleColumns} />
        ) : (
          <TableRow>
            <TableCell colSpan={visibleColumns.length || 1} className="h-40 whitespace-normal text-center">
              {hasActiveFilters ? (
                <Empty className="border-0 p-4">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchXIcon className="size-4" />
                    </EmptyMedia>
                    <EmptyTitle>No results</EmptyTitle>
                    <EmptyDescription>Try adjusting or clearing your filters.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button type="button" variant="outline" size="sm" onClick={() => resetTableFilters(table)}>
                      Clear filters
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <Empty className="border-0 p-4">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <InboxIcon className="size-4" />
                    </EmptyMedia>
                    <EmptyTitle>{emptyLabel}</EmptyTitle>
                    {emptyDescription ? (
                      <EmptyDescription>{emptyDescription}</EmptyDescription>
                    ) : null}
                  </EmptyHeader>
                  {emptyAction ? <EmptyContent>{emptyAction}</EmptyContent> : null}
                </Empty>
              )}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
      {renderFooter?.()}
    </Table>
  )
}

function SkeletonRows<TData>({ columns }: { columns: Column<TData, unknown>[] }) {
  return Array.from({ length: 10 }).map((_, rowIndex) => (
    <TableRow key={`table-skeleton-row-${rowIndex}`}>
      {columns.map((column, columnIndex) => {
        const align = getColumnAlign(column.columnDef.meta)
        const isActionColumn = column.id === "actions"
        return (
          <TableCell
            key={`table-skeleton-cell-${rowIndex}-${column.id}`}
            className={cn(
              isActionColumn && "sticky right-0 z-10 w-10 min-w-10 border-l bg-background",
              align === "center" && "text-center",
              align === "right" && "text-right"
            )}
          >
            <Skeleton
              className={cn(
                "h-4 rounded-none",
                columnIndex === 0 ? "w-24" : "w-28",
                align === "center" && "mx-auto",
                align === "right" && "ml-auto",
                isActionColumn && "ml-auto w-4"
              )}
            />
          </TableCell>
        )
      })}
    </TableRow>
  ))
}

function LinkedCell<TData>({
  row,
  cell,
  getLink,
}: {
  row: Row<TData>
  cell: TanstackCell<TData, unknown>
  getLink?: LinkResolver<TData>
}) {
  const meta = cell.column.columnDef.meta
  const linkEnabled = meta?.linkEnabled
  const align = getColumnAlign(cell.column.columnDef.meta)
  const valueClassName = getColumnValueClassName(cell.column.columnDef.meta)
  const isActionColumn = cell.column.id === "actions"
  const hasMaxWidth = Boolean(meta?.maxWidthClassName)
  const shouldTruncate = hasMaxWidth && !meta?.wrap
  const className = cn(
    "min-w-0",
    valueClassName,
    meta?.cellClassName,
    meta?.maxWidthClassName,
    hasMaxWidth && "overflow-hidden",
    isActionColumn && "sticky right-0 z-10 w-10 min-w-10 border-l bg-background group-hover:bg-muted/50 group-data-[state=selected]:bg-muted",
    meta?.wrap && "whitespace-normal break-words",
    align === "center" && "text-center",
    align === "right" && "text-right"
  )
  const contentClassName = cn(
    "flex min-w-0 max-w-full overflow-hidden p-2",
    meta?.wrap ? "items-start" : "items-center",
    meta?.wrap ? "whitespace-normal break-words" : "whitespace-nowrap",
    meta?.maxWidthClassName,
    hasMaxWidth && "max-w-full",
    shouldTruncate && "truncate [&>*]:truncate",
    align === "center" && "w-full justify-center",
    align === "right" && "w-full justify-end"
  )
  const staticContentClassName = cn(
    "min-w-0 max-w-full overflow-hidden",
    meta?.wrap ? "whitespace-normal break-words" : "whitespace-nowrap",
    meta?.maxWidthClassName,
    hasMaxWidth && "max-w-full",
    shouldTruncate && "truncate [&>*]:truncate",
    align === "center" && "flex w-full justify-center",
    align === "right" && "flex w-full justify-end"
  )

  if (!isActionColumn && (linkEnabled === undefined || linkEnabled) && getLink) {
    return (
      <TableCell className={cn("p-0", className)}>
        <Link to={getLink(row.original)} className={contentClassName}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </Link>
      </TableCell>
    )
  }

  return (
    <TableCell className={className}>
      <div className={staticContentClassName}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
    </TableCell>
  )
}
