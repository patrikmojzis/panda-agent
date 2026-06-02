import type { Table, VisibilityState } from "@tanstack/react-table"
import { ChevronDown, Columns2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type ColumnsVisibilityMenuProps<TData> = {
  table: Table<TData>
  defaultState?: VisibilityState
}

export default function ColumnsVisibilityMenu<TData>({ table, defaultState }: ColumnsVisibilityMenuProps<TData>) {
  const hideableColumns = table.getAllColumns().filter((column) => column.getCanHide())
  const visibility = table.getState().columnVisibility
  const visibleHideableCount = hideableColumns.filter((column) => column.getIsVisible()).length
  const modifiedColumns = hideableColumns.filter((column) => {
    const current = visibility[column.id] ?? true
    const defaultValue = defaultState?.[column.id] ?? true
    return current !== defaultValue
  })
  const modifiedCount = modifiedColumns.length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={modifiedCount > 0 ? "secondary" : "outline"} size="sm" className="ml-auto">
          <Columns2 className="size-4" />
          Columns
          {modifiedCount > 0 ? <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem]">{modifiedCount}</Badge> : null}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Hide or show</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {hideableColumns.map((column) => {
            const isLastVisibleColumn = column.getIsVisible() && visibleHideableCount <= 1
            return (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={column.getIsVisible()}
                disabled={isLastVisibleColumn}
                onCheckedChange={(value) => {
                  if (isLastVisibleColumn) return
                  column.toggleVisibility(Boolean(value))
                }}
              >
                {String(column.columnDef.meta?.label ?? column.id)}
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuGroup>
        {visibleHideableCount === 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Keep one column visible</DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={modifiedCount === 0} onClick={() => table.setColumnVisibility(defaultState ?? {})}>
            Reset defaults
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
