import type { DataTableState } from "@/components/common/data-table/hooks/use-data-table-state"
import FilterButton from "@/components/common/data-table/ui/filter-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type TableSelectFilterOption = {
  label: string
  value: string
}

type TableSelectFilterProps = {
  state: DataTableState
  id: string
  label: string
  allLabel: string
  options: TableSelectFilterOption[]
  triggerClassName?: string
}

export default function TableSelectFilter({
  state,
  id,
  label,
  allLabel,
  options,
  triggerClassName = "max-w-full sm:max-w-56",
}: TableSelectFilterProps) {
  const activeFilter = state.columnFilters.find(
    (filter) => filter.id === id
  )?.value
  const activeValue =
    typeof activeFilter === "string" && activeFilter.trim()
      ? activeFilter
      : "all"
  const effectiveOptions =
    activeValue === "all" ||
    options.some((option) => option.value === activeValue)
      ? options
      : [{ label: activeValue, value: activeValue }, ...options]
  const selectedLabel = effectiveOptions.find(
    (option) => option.value === activeValue
  )?.label
  const isActive = activeValue !== "all"
  const triggerLabel = isActive
    ? `${label} filter: ${selectedLabel ?? activeValue}`
    : `${label} filter`

  function handleValueChange(nextValue: string) {
    state.setColumnFilters((previous) => {
      const withoutFilter = previous.filter((filter) => filter.id !== id)
      if (nextValue === "all") return withoutFilter
      return [...withoutFilter, { id, value: nextValue }]
    })
    state.setPagination((previous) =>
      previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton
          label={label}
          value={isActive ? (selectedLabel ?? activeValue) : undefined}
          renderValue={(value) => value}
          className={cn(
            triggerClassName,
            "w-auto max-w-full"
          )}
          aria-label={triggerLabel}
          title={triggerLabel}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuRadioGroup
          value={activeValue}
          onValueChange={handleValueChange}
        >
          <DropdownMenuRadioItem value="all">{allLabel}</DropdownMenuRadioItem>
          {effectiveOptions.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
