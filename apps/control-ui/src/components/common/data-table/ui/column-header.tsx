import type * as React from "react"
import type { Column } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

import { getColumnAlign } from "@/components/common/data-table/ui/column-meta"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function ColumnHeader({ column, children }: { column: Column<unknown, unknown>; children: React.ReactNode }) {
  const align = getColumnAlign(column.columnDef.meta)

  if (!column.getCanSort()) return <>{children}</>

  function handleClick() {
    const sorted = column.getIsSorted()
    if (sorted === "desc") column.toggleSorting(false)
    else if (sorted === "asc") column.clearSorting()
    else column.toggleSorting(true)
  }

  const sorted = column.getIsSorted()

  return (
    <Button
      variant="ghost"
      className={cn(
        "h-auto px-0 text-xs uppercase text-muted-foreground hover:bg-transparent hover:text-accent-foreground",
        align === "center" && "w-full justify-center text-center",
        align === "right" && "w-full justify-end text-right"
      )}
      onClick={handleClick}
      type="button"
    >
      {children}
      {sorted === "desc" ? (
        <ArrowDown className="size-3" />
      ) : sorted === "asc" ? (
        <ArrowUp className="size-3" />
      ) : (
        <ArrowUpDown className="size-3 opacity-40" />
      )}
    </Button>
  )
}

function renderColumnHeader<TData, TValue>({ column }: { column: Column<TData, TValue> }) {
  return <ColumnHeader column={column as Column<unknown, unknown>}>{column.columnDef.meta?.label ?? "–"}</ColumnHeader>
}

export { ColumnHeader, renderColumnHeader }
