import * as React from "react"
import type { Table } from "@tanstack/react-table"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function nextGlobalFilter(
  previous: Record<string, string | undefined> | undefined,
  id: string,
  value: string
) {
  const next = { ...(previous ?? {}) }
  if (value) next[id] = value
  else delete next[id]
  return next
}

export default function SearchFilter<TData>({
  table,
  id = "search",
}: {
  table: Table<TData>
  id?: string
}) {
  const debounceTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const globalFilter = table.getState().globalFilter as
    | Record<string, string | undefined>
    | undefined
  const externalValue = globalFilter?.[id] ?? ""
  const [draft, setDraft] = React.useState({
    externalValue,
    value: externalValue,
  })
  const value =
    draft.externalValue === externalValue ? draft.value : externalValue

  React.useEffect(() => {
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current)
      debounceTimeout.current = null
    }
  }, [externalValue])

  React.useEffect(
    () => () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current)
    },
    []
  )

  function commitSearch(nextValue: string) {
    table.setGlobalFilter(
      (previous: Record<string, string | undefined> | undefined) =>
        nextGlobalFilter(previous, id, nextValue)
    )
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value
    setDraft({ externalValue, value: nextValue })
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current)
    debounceTimeout.current = setTimeout(() => {
      debounceTimeout.current = null
      commitSearch(nextValue)
    }, 200)
  }

  function handleClear() {
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current)
    debounceTimeout.current = null
    setDraft({ externalValue, value: "" })
    commitSearch("")
  }

  return (
    <div className="relative min-w-40 flex-1 basis-full sm:max-w-xs sm:basis-auto">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pr-8 pl-8"
        value={value}
        onChange={handleChange}
        placeholder="Search"
      />
      {value ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
          onClick={handleClear}
          aria-label="Clear search"
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
