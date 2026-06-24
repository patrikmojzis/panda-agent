import { Link } from "react-router-dom"

import { sessionPath } from "@/app/control-routes"
import { Button } from "@/components/ui/button"
import {
  friendlySessionLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import type { ModelCallTraceSummary } from "@/lib/api"

import { shortModelCallContextValue } from "./model-call-display"

export function ProviderModel({ trace }: { trace: ModelCallTraceSummary }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="break-words font-medium">{trace.provider}</span>
      <code className="break-all text-xs text-muted-foreground">{trace.model}</code>
    </div>
  )
}

export function TraceContext({
  showSessionLink = true,
  trace,
}: {
  showSessionLink?: boolean
  trace: ModelCallTraceSummary
}) {
  const items = [
    trace.agentKey ? { label: "Agent", value: trace.agentKey } : null,
    trace.sessionId
      ? {
          label: "Session",
          value: sessionContextLabel(trace),
          title: trace.sessionId,
        }
      : null,
    trace.runId ? { label: "Run", value: trace.runId } : null,
    trace.threadId ? { label: "Thread", value: trace.threadId } : null,
    trace.turn !== null ? { label: "Turn", value: String(trace.turn) } : null,
    trace.callIndex !== null ? { label: "Call", value: `#${trace.callIndex}` } : null,
  ].filter((item): item is { label: string; value: string; title?: string } => Boolean(item))

  if (items.length === 0) return <span className="text-muted-foreground">-</span>

  return (
    <div className="flex min-w-0 max-w-full flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 border px-1.5 py-0.5 text-xs"
          title={item.title ?? item.value}
        >
          <span className="shrink-0 text-muted-foreground">{item.label}</span>
          <code className="min-w-0 truncate">{shortModelCallContextValue(item.value)}</code>
        </span>
      ))}
      {showSessionLink ? <SessionLink trace={trace} /> : null}
    </div>
  )
}

function SessionLink({ trace }: { trace: ModelCallTraceSummary }) {
  if (!trace.agentKey || !trace.sessionId) return null
  return (
    <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
      <Link to={sessionPath(trace.agentKey, trace.sessionId)}>Open session</Link>
    </Button>
  )
}

function sessionContextLabel(trace: ModelCallTraceSummary) {
  if (!trace.sessionId) return ""
  const label = friendlySessionLabel({
    id: trace.sessionId,
    label: trace.sessionLabel,
    displayName: trace.sessionDisplayName,
    alias: trace.sessionAlias,
    kind: trace.sessionKind,
  })
  return `${label} · ${shortSessionId(trace.sessionId)}`
}
