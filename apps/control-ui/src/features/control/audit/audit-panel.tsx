import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Eye } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useAuditEvents } from "@/features/control/api/queries"
import {
  formatDate,
  humanize,
  mobileHiddenColumns,
  short,
} from "@/features/control/control-display"
import type { AuditEvent } from "@/lib/api"

export function AuditPanel({
  agentKey,
  sessionId,
}: {
  agentKey?: string
  sessionId?: string
}) {
  const tableKey = ["audit", agentKey ?? "all", sessionId ?? "all"].join(":")
  const table = useDataTableState(tableKey, {
    sort_by: "createdAt",
    sort_direction: "desc",
  })
  const params = {
    ...table.params,
    ...(agentKey ? { agentKey } : {}),
    ...(sessionId ? { targetSessionId: sessionId } : {}),
  }
  const audit = useAuditEvents(params)
  const [selectedEvent, setSelectedEvent] = React.useState<AuditEvent | null>(null)
  const columns: ColumnDef<AuditEvent>[] = [
    {
      accessorKey: "eventType",
      meta: { label: "Event" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <Cell highlighted>{humanize(row.original.eventType)}</Cell>
      ),
    },
    {
      id: "context",
      meta: { label: "Context", wrap: true, maxWidthClassName: "max-w-md" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <AuditContext event={row.original} />,
    },
    {
      accessorKey: "metadata",
      meta: { label: "Details", wrap: true, maxWidthClassName: "max-w-xl" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <AuditDetails metadata={row.original.metadata} />,
    },
    {
      accessorKey: "identityId",
      meta: { label: "Identity" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{short(row.original.identityId)}</Cell>,
    },
    {
      accessorKey: "createdAt",
      meta: { label: "Created", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.createdAt)}</Cell>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for audit event ${short(row.original.id)}`}
          actions={[
            {
              label: "Inspect",
              icon: <Eye className="size-4" />,
              onSelect: () => setSelectedEvent(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <div className="grid gap-3">
      <div className="border p-3 text-xs text-muted-foreground">
        {sessionId
          ? "Showing audit events for this session."
          : agentKey
            ? "Showing audit events for this agent."
            : "Showing visible audit events."}
      </div>
      <DataTableView
        columns={columns}
        response={audit.data}
        state={table}
        error={audit.error}
        isFetching={audit.isFetching}
        isLoading={audit.isLoading}
        isPlaceholderData={audit.isPlaceholderData}
        onRetry={() => void audit.refetch()}
        rowKey={(row) => row.id}
        filters={<AuditEventTypeFilter state={table} />}
        emptyLabel={
          sessionId
            ? "No audit events for this session."
            : agentKey
              ? "No audit events for this agent."
              : "No visible audit events."
        }
        mobileColumnVisibility={mobileHiddenColumns("metadata", "identityId")}
      />
      <AuditEventDetailsSheet
        event={selectedEvent}
        setEvent={setSelectedEvent}
      />
    </div>
  )
}

const auditEventTypeOptions = [
  { label: "Operator writes", value: "control_operator_write" },
  { label: "Prompt writes", value: "session_prompt_write" },
  { label: "Briefing writes", value: "session_briefing_write" },
  { label: "Wake policy writes", value: "session_heartbeat_config_write" },
  { label: "Automation writes", value: "session_scheduled_task_write" },
  { label: "Watch writes", value: "session_watch_config_write" },
  { label: "Dev logins", value: "control_dev_login" },
  { label: "Logouts", value: "logout" },
]

function AuditEventTypeFilter({ state }: { state: DataTableState }) {
  return (
    <TableSelectFilter
      state={state}
      id="eventType"
      label="Event"
      allLabel="All events"
      options={auditEventTypeOptions}
    />
  )
}

function AuditContext({ event }: { event: AuditEvent }) {
  const metadata = event.metadata
  const entries = [
    typeof metadata.agentKey === "string"
      ? { label: "Agent", value: metadata.agentKey }
      : null,
    typeof metadata.targetSessionId === "string"
      ? { label: "Session", value: short(metadata.targetSessionId) }
      : null,
    typeof metadata.sessionId === "string"
      ? { label: "Session", value: short(metadata.sessionId) }
      : null,
    typeof metadata.envKey === "string"
      ? { label: "Credential", value: metadata.envKey }
      : null,
    typeof metadata.connectorKey === "string"
      ? { label: "Connector", value: metadata.connectorKey }
      : null,
    typeof metadata.sourceId === "string"
      ? { label: "Source", value: metadata.sourceId }
      : null,
    typeof metadata.deviceId === "string"
      ? { label: "Device", value: metadata.deviceId }
      : null,
    typeof metadata.skillKey === "string"
      ? { label: "Skill", value: metadata.skillKey }
      : null,
    typeof metadata.slug === "string"
      ? { label: "Subagent", value: metadata.slug }
      : null,
  ].filter((entry): entry is { label: string; value: string } => Boolean(entry))

  if (entries.length === 0)
    return <span className="text-muted-foreground">-</span>

  return (
    <div className="flex max-w-md flex-wrap gap-1">
      {entries.slice(0, 4).map((entry) => (
        <AuditChip
          key={`${entry.label}:${entry.value}`}
          label={entry.label}
          value={entry.value}
        />
      ))}
    </div>
  )
}

function AuditDetails({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = auditEntries(metadata).filter(
    ([key]) => !["agentKey", "targetSessionId", "sessionId"].includes(key)
  )
  if (entries.length === 0)
    return <span className="text-muted-foreground">No details</span>

  return (
    <div className="flex max-w-xl flex-wrap gap-1">
      {entries.slice(0, 8).map(([key, value]) => (
        <AuditChip key={key} label={humanize(key)} value={value} />
      ))}
    </div>
  )
}

function AuditEventDetailsSheet({
  event,
  setEvent,
}: {
  event: AuditEvent | null
  setEvent: (event: AuditEvent | null) => void
}) {
  const metadataEntries = event ? auditEntries(event.metadata) : []

  return (
    <Sheet open={Boolean(event)} onOpenChange={(open) => !open && setEvent(null)}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Audit Event</SheetTitle>
          <SheetDescription>
            {event
              ? `${humanize(event.eventType)} - ${formatDate(event.createdAt) ?? "-"}`
              : "Sanitized audit event details"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {event ? (
            <div className="grid gap-4">
              <section className="grid gap-3 border p-3">
                <div className="text-sm font-medium">Event</div>
                <AuditDetailRow label="Type" value={humanize(event.eventType)} />
                <AuditDetailRow label="Created" value={formatDate(event.createdAt) ?? "-"} />
                <AuditDetailRow label="Identity" value={event.identityId ?? "-"} mono />
                <AuditDetailRow label="Event id" value={event.id} mono />
              </section>
              <section className="grid gap-3 border p-3">
                <div className="text-sm font-medium">Metadata</div>
                {metadataEntries.length > 0 ? (
                  <div className="grid gap-2">
                    {metadataEntries.map(([key, value]) => (
                      <AuditDetailRow
                        key={key}
                        label={humanize(key)}
                        value={value}
                        mono={looksIdentifierLike(key)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No metadata.</div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function AuditDetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? "break-all font-mono text-xs" : "break-words text-sm font-medium"}>
        {value || "-"}
      </div>
    </div>
  )
}

function AuditChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 border px-1.5 py-0.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium" title={value}>
        {value}
      </span>
    </span>
  )
}

function auditEntries(
  metadata: Record<string, unknown>,
  prefix = ""
): Array<[string, string]> {
  return Object.entries(metadata).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value === null || value === undefined) return []
    if (typeof value === "object" && !Array.isArray(value))
      return auditEntries(value as Record<string, unknown>, fullKey)
    const rendered = Array.isArray(value) ? value.join(", ") : String(value)
    return rendered ? [[fullKey, rendered]] : []
  })
}

function looksIdentifierLike(key: string) {
  return /(^id$|id$|key$|slug$|hash|sha|token)/i.test(key)
}
