import type * as React from "react"

import { formatNumber } from "@/features/control/formatting"
import { cn } from "@/lib/utils"

type CellProps = {
  children?: React.ReactNode
  condition?: boolean
  highlighted?: boolean
  className?: string
}

function CellEmpty({ className }: { className?: string }) {
  return <span className={cn("text-muted-foreground/50", className)}>–</span>
}

function Cell({ children, condition = true, highlighted = false, className }: CellProps) {
  if (!condition || children === null || children === undefined || children === "") {
    return <CellEmpty className={className} />
  }

  if (typeof children === "string" || typeof children === "number") {
    const value = typeof children === "number" ? formatNumber(children) : children
    return <span className={cn(highlighted && "font-semibold", className)}>{value}</span>
  }

  if (className) return <span className={className}>{children}</span>

  return children
}

export { Cell, CellEmpty }
