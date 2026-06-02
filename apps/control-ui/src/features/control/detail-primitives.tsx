import type { ReactNode } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function DetailPanel({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("min-w-0 border p-3", className)}>
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 truncate text-sm font-medium">{title}</div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function DetailField({
  label,
  value,
  loading = false,
}: {
  label: string
  value?: ReactNode
  loading?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 min-h-5 break-words text-sm leading-snug font-medium">
        {loading ? <Skeleton className="h-4 w-24" /> : (value ?? "-")}
      </div>
    </div>
  )
}

export function DetailSection({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <section className={cn("grid gap-3", className)}>{children}</section>
}

export function DetailSectionLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <h2 className={cn("text-sm font-semibold tracking-normal", className)}>
      {children}
    </h2>
  )
}

export function DetailsGrid({
  children,
  className,
  placement = "sidebar",
}: {
  children: ReactNode
  className?: string
  placement?: "main" | "sidebar"
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        placement === "main"
          ? "sm:grid-cols-2 xl:grid-cols-4"
          : "sm:grid-cols-2 lg:grid-cols-1",
        className
      )}
    >
      {children}
    </div>
  )
}

export function TableError({ error }: { error: unknown }) {
  return (
    <div className="border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
      {controlErrorMessage(error)}
    </div>
  )
}

export function controlErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Control request failed"
}
