import * as React from "react"
import { ChevronDown, SearchIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useFieldContext } from "@/components/common/form/form-context"
import { fieldErrors } from "@/components/common/form/field-errors"
import { FieldLabelText } from "@/components/common/form/fields/field-label-text"
import { cn } from "@/lib/utils"

export function MultiSelectField({
  label,
  description,
  options,
  placeholder = "Select options",
  required,
}: {
  label: string
  description?: string
  options: Array<{ label: string; value: string; description?: string }>
  placeholder?: string
  required?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const field = useFieldContext<string[]>()
  const invalid = field.state.meta.errors.length > 0
  const selected = Array.isArray(field.state.value) ? field.state.value : []
  const selectedOptions = selected.map((value) => options.find((option) => option.value === value) ?? { label: value, value })
  const normalizedQuery = query.trim().toLowerCase()
  const visibleOptions = React.useMemo(
    () =>
      normalizedQuery
        ? options.filter((option) =>
            [option.label, option.value, option.description]
              .filter(Boolean)
              .some((part) => part?.toLowerCase().includes(normalizedQuery))
          )
        : options,
    [normalizedQuery, options]
  )

  function toggle(value: string, checked: boolean) {
    field.handleChange(checked ? [...selected, value] : selected.filter((item) => item !== value))
  }

  function clearSelected() {
    field.handleChange([])
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={field.name}
            type="button"
            variant="outline"
            aria-invalid={invalid}
            aria-required={required || undefined}
            className="h-auto min-h-9 w-full justify-between gap-2 px-3 py-2 font-normal"
            onBlur={field.handleBlur}
          >
            <span className="flex min-w-0 flex-wrap gap-1">
              {selected.length > 0 ? (
                <>
                  {selectedOptions.slice(0, 3).map((option) => (
                    <Badge key={option.value} variant="secondary" className="max-w-40">
                      <span className="truncate">{option.label}</span>
                    </Badge>
                  ))}
                  {selectedOptions.length > 3 ? (
                    <Badge variant="outline">+{selectedOptions.length - 3}</Badge>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">{placeholder}</span>
              )}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {selected.length > 0 ? (
                <span className="text-muted-foreground">{selected.length}</span>
              ) : null}
              <ChevronDown className="size-4 text-muted-foreground" />
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-1">
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <div className="min-w-0 text-xs text-muted-foreground">
              {selected.length > 0 ? `${selected.length} selected` : placeholder}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={selected.length === 0}
              onClick={clearSelected}
            >
              <XIcon className="size-3" />
              Clear
            </Button>
          </div>
          <div className="relative px-1 pb-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="Search options"
              className="h-7 pl-7"
            />
          </div>
          <DropdownMenuSeparator />
          <div className="max-h-72 overflow-y-auto">
            {visibleOptions.length > 0 ? (
              visibleOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={selected.includes(option.value)}
                  className="items-start"
                  onCheckedChange={(checked) => toggle(option.value, checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <span className={cn("truncate", selected.includes(option.value) && "font-medium")}>
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="line-clamp-2 text-muted-foreground">{option.description}</span>
                    ) : null}
                  </span>
                </DropdownMenuCheckboxItem>
              ))
            ) : (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                No matching options.
              </div>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={fieldErrors(field.state.meta.errors)} />
    </Field>
  )
}
