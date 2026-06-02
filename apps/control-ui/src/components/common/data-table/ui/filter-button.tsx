import * as React from "react"
import { ChevronDownIcon, CirclePlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

type FilterButtonProps<TValue> = {
  label: string
  value?: TValue | null
  renderValue: (value: TValue) => React.ReactNode
}

function FilterButtonInner<TValue>(
  {
    label,
    value,
    renderValue,
    className,
    ...props
  }: FilterButtonProps<TValue> &
    Omit<React.ComponentPropsWithoutRef<"button">, "value">,
  ref: React.ForwardedRef<HTMLButtonElement>
) {
  const hasValue = value !== null && value !== undefined

  return (
    <Button
      ref={ref}
      type="button"
      variant={hasValue ? "secondary" : "outline"}
      size="sm"
      className={cn(
        "min-w-0 justify-start rounded-full",
        !hasValue && "border-dashed",
        className
      )}
      {...props}
    >
      {!hasValue ? <CirclePlusIcon className="size-3.5" /> : null}
      <span className="truncate">{label}</span>
      {hasValue ? (
        <>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <span className="min-w-0 truncate text-foreground">
            {renderValue(value)}
          </span>
          <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </>
      ) : (
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      )}
    </Button>
  )
}

const FilterButton = React.forwardRef(FilterButtonInner) as <TValue>(
  props: FilterButtonProps<TValue> &
    Omit<React.ComponentPropsWithoutRef<"button">, "value"> &
    React.RefAttributes<HTMLButtonElement>
) => React.ReactElement

export default FilterButton
