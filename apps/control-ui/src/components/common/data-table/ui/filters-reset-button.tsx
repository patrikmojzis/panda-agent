import type { Table } from "@tanstack/react-table"
import { XIcon } from "lucide-react"

import { hasActiveTableFilters, resetTableFilters } from "@/components/common/data-table/ui/filter-state"
import { Button } from "@/components/ui/button"

export default function FiltersResetButton<TData>({ table }: { table: Table<TData> }) {
  const isVisible = hasActiveTableFilters(table)

  if (!isVisible) return null

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => resetTableFilters(table)}
    >
      Clear filters
      <XIcon className="size-3.5" />
    </Button>
  )
}
