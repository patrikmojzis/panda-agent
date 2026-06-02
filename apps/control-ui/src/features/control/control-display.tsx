import type * as React from "react"
import type { VisibilityState } from "@tanstack/react-table"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatDate } from "@/features/control/formatting"
import type { ScheduledTask } from "@/lib/api"
import { cn } from "@/lib/utils"

export { formatDate } from "@/features/control/formatting"

export const enabledFilterOptions = [
  { label: "Enabled", value: "true" },
  { label: "Disabled", value: "false" },
]

export function mobileHiddenColumns(...columns: string[]): VisibilityState {
  return Object.fromEntries(columns.map((column) => [column, false]))
}

export function Metric({
  label,
  value,
}: {
  label: string
  value?: React.ReactNode
}) {
  return (
    <div className="border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm leading-snug font-medium break-words">
        {value ?? "-"}
      </div>
    </div>
  )
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusBadgeVariant(status)}>{humanize(status)}</Badge>
}

export function TruncatedText({
  value,
  className,
}: {
  value?: string | null
  className?: string
}) {
  const text = value?.trim()
  const content = (
    <span
      className={cn(
        "block max-w-full min-w-0 truncate text-muted-foreground",
        className
      )}
      title={text || undefined}
    >
      {text || "-"}
    </span>
  )

  if (!text) return content

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-lg text-left leading-relaxed whitespace-normal"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

export function TokenBadges({
  values,
  className,
}: {
  values: string[]
  className?: string
}) {
  return (
    <div className={cn("flex max-w-full min-w-0 flex-wrap gap-1 overflow-hidden", className)}>
      {values.length > 0
        ? values.map((value) => (
            <Badge key={value} variant="outline" className="max-w-full min-w-0">
              <span className="min-w-0 truncate" title={value}>
                {value}
              </span>
            </Badge>
          ))
        : "-"}
    </div>
  )
}

export function formatSchedule(schedule: ScheduledTask["schedule"]) {
  if (schedule.kind === "once")
    return `Once - ${formatDate(schedule.runAt) ?? "-"}`
  return `${schedule.cron} - ${schedule.timezone}`
}

export function short(value?: string) {
  return value ? value.slice(0, 8) : "-"
}

export function humanize(value?: string | null) {
  if (!value) return "-"
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function statusBadgeVariant(
  status: string
): React.ComponentProps<typeof Badge>["variant"] {
  const normalized = status.toLowerCase()
  if (["failed", "error", "quarantined"].includes(normalized))
    return "destructive"
  if (["running", "processing"].includes(normalized)) return "default"
  if (["disabled", "cancelled", "cooldown", "suspended"].includes(normalized))
    return "secondary"
  return "outline"
}
