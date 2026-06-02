import type { DataTableState } from "@/components/common/data-table/hooks/use-data-table-state"
import FilterButton from "@/components/common/data-table/ui/filter-button"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type TableMultiSelectFilterOption = {
  label: string
  value: string
}

type TableMultiSelectFilterProps = {
  allLabel: string
  id: string
  label: string
  options: TableMultiSelectFilterOption[]
  state: DataTableState
  triggerClassName?: string
}

export default function TableMultiSelectFilter({
  allLabel,
  id,
  label,
  options,
  state,
  triggerClassName = "max-w-full sm:max-w-56",
}: TableMultiSelectFilterProps) {
  const activeFilter = state.columnFilters.find((filter) => filter.id === id)
    ?.value
  const activeValues = normalizeActiveValues(activeFilter)
  const selectedOptions = activeValues.map(
    (value) => options.find((option) => option.value === value) ?? { label: value, value }
  )
  const selectedLabel =
    selectedOptions.length === 1
      ? selectedOptions[0]?.label
      : selectedOptions.length > 1
        ? `${selectedOptions.length} selected`
        : undefined
  const triggerLabel = selectedLabel
    ? `${label} filter: ${selectedOptions.map((option) => option.label).join(", ")}`
    : `${label} filter`

  function setValues(nextValues: string[]) {
    state.setColumnFilters((previous) => {
      const withoutFilter = previous.filter((filter) => filter.id !== id)
      if (nextValues.length === 0) return withoutFilter
      return [...withoutFilter, { id, value: nextValues }]
    })
    state.setPagination((previous) =>
      previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }
    )
  }

  function toggleValue(value: string, checked: boolean) {
    setValues(
      checked
        ? [...activeValues, value]
        : activeValues.filter((item) => item !== value)
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton
          label={label}
          value={selectedLabel}
          renderValue={(value) => value}
          className={cn(triggerClassName, "w-auto max-w-full")}
          aria-label={triggerLabel}
          title={triggerLabel}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {selectedLabel ?? allLabel}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activeValues.length === 0}
            onClick={() => setValues([])}
          >
            Clear
          </Button>
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {options.length > 0 ? (
            options.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={activeValues.includes(option.value)}
                onCheckedChange={(checked) =>
                  toggleValue(option.value, checked === true)
                }
                onSelect={(event) => event.preventDefault()}
              >
                <span className="truncate">{option.label}</span>
              </DropdownMenuCheckboxItem>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No options.
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function normalizeActiveValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .filter((item) => item.trim() !== "")
  }
  if (typeof value === "string" && value.trim()) return [value]
  return []
}
