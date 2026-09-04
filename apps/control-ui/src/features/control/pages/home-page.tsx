import { useNavigate } from "react-router-dom"
import type { ColumnDef } from "@tanstack/react-table"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { Bar, BarChart, XAxis, YAxis } from "recharts"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { PageHeader } from "@/components/common/shared/page-layout"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  humanize,
  mobileHiddenColumns,
  TruncatedText,
} from "@/features/control/control-display"
import {
  useWorkFailures,
} from "@/features/control/api/queries"
import {
  formatDate,
  formatNumber,
} from "@/features/control/formatting"
import { sessionReferenceLabel } from "@/features/control/session-labels"
import type { WorkFailure } from "@/lib/api"
import { cn } from "@/lib/utils"

const workFailureSeverityFilterOptions = [
  { label: "Critical", value: "critical" },
  { label: "Warning", value: "warning" },
]

const workFailureKindFilterOptions = [
  { label: "Runtime", value: "runtime_run" },
  { label: "Scheduled", value: "scheduled_task_run" },
  { label: "Outbound", value: "outbound_delivery" },
  { label: "Channel action", value: "channel_action" },
  { label: "Gateway event", value: "gateway_event" },
  { label: "Gateway command", value: "gateway_device_command" },
  { label: "Connector", value: "connector_account" },
]

function HomePage() {
  const navigate = useNavigate()
  const table = useDataTableState("home-failures", {
    per_page: 20,
    sort_by: "createdAt",
    sort_direction: "desc",
  })
  const failures = useWorkFailures(table.params)
  const visibleFailures = failures.error ? [] : failures.data?.data ?? []
  const counts = failures.error ? undefined : failures.data?.counts
  const latestFailure = visibleFailures.reduce<WorkFailure | undefined>(
    (latest, failure) => {
      if (!latest) return failure
      return new Date(failure.createdAt).getTime() >
        new Date(latest.createdAt).getTime()
        ? failure
        : latest
    },
    undefined
  )
  const byKind = Object.entries(
    visibleFailures.reduce<Record<string, number>>((counts, failure) => {
      counts[failure.kind] = (counts[failure.kind] ?? 0) + 1
      return counts
    }, {})
  )
    .map(([kind, count]) => ({ kind, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.kind.localeCompare(right.kind)
    )

  const columns: ColumnDef<WorkFailure>[] = [
    {
      accessorKey: "severity",
      meta: { label: "Severity" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.severity === "critical" ? "destructive" : "outline"
          }
        >
          {row.original.severity}
        </Badge>
      ),
    },
    {
      accessorKey: "source",
      meta: { label: "Source" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.source}</Cell>,
    },
    {
      accessorKey: "summary",
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      meta: { label: "Failure", maxWidthClassName: "max-w-[34rem]" },
      cell: ({ row }) => (
        <TruncatedText
          value={row.original.summary}
          className="max-w-[32rem] font-medium text-foreground"
        />
      ),
    },
    {
      accessorKey: "agentKey",
      meta: { label: "Agent" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.agentKey}</Cell>,
    },
    {
      accessorKey: "sessionLabel",
      meta: { label: "Session" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText
          value={sessionReferenceLabel(
            row.original.sessionLabel,
            row.original.sessionId
          )}
        />
      ),
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
          triggerLabel={`Open actions for ${row.original.summary}`}
          actions={[
            {
              label: "Open target",
              icon: <ExternalLink className="size-4" />,
              onSelect: () => navigate(row.original.targetRoute),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="Work Failures" eyebrow="Home" />
      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 border p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            Current attention
          </div>
          <DataTableView
            columns={columns}
            response={failures.data}
            state={table}
            error={failures.error}
            filters={<WorkFailureFilters state={table} />}
            isFetching={failures.isFetching}
            isLoading={failures.isLoading}
            isPlaceholderData={failures.isPlaceholderData}
            onRetry={() => void failures.refetch()}
            rowKey={(row) => row.id}
            getLink={(row) => row.targetRoute}
            emptyLabel="No work failures match these filters"
            mobileColumnVisibility={mobileHiddenColumns(
              "source",
              "sessionLabel",
              "createdAt"
            )}
          />
        </div>
        <div className="min-w-0 border p-3">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Triage snapshot</div>
              <div className="text-xs text-muted-foreground">
                Counts cover retained failures matching search and type.
              </div>
            </div>
            {failures.isFetching ? (
              <Badge variant="outline">Refreshing</Badge>
            ) : null}
          </div>
          <div className="mb-4 grid grid-cols-3 divide-x border-y">
            <FailureStat label="Total" value={counts?.total} />
            <FailureStat label="Critical" value={counts?.critical} tone="critical" />
            <FailureStat label="Warning" value={counts?.warning} />
          </div>
          <div className="mb-4">
            <div className="text-xs font-medium text-muted-foreground uppercase">
              Latest on this page
            </div>
            <div className="mt-1 truncate text-sm" title={latestFailure?.summary}>
              {latestFailure?.summary ?? (counts ? "None on this page" : "Unavailable")}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatDate(latestFailure?.createdAt) ?? "-"}
            </div>
          </div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Failure mix</div>
            <div className="text-xs text-muted-foreground">Current page</div>
          </div>
          {byKind.length > 0 ? (
            <div className="grid gap-3">
              <ChartContainer
                config={{
                  count: { label: "Failures", color: "var(--primary)" },
                }}
                className="aspect-auto h-32 w-full"
              >
                <BarChart data={byKind}>
                  <XAxis dataKey="kind" hide />
                  <YAxis allowDecimals={false} width={24} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" />
                </BarChart>
              </ChartContainer>
              <div className="grid gap-1">
                {byKind.map((item) => (
                  <div
                    key={item.kind}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate text-muted-foreground">
                      {humanize(item.kind)}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatNumber(item.count)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="border border-dashed p-4 text-sm text-muted-foreground">
              {failures.error ? "Failure snapshot could not be loaded." : counts ? "No failures on this page." : "Loading failure snapshot…"}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FailureStat({
  label,
  tone,
  value,
}: {
  label: string
  tone?: "critical"
  value?: number
}) {
  return (
    <div className="min-w-0 p-2">
      <div className="truncate text-[0.68rem] font-medium text-muted-foreground uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "critical" && value !== undefined && value > 0 && "text-destructive"
        )}
      >
        {value === undefined ? "—" : formatNumber(value)}
      </div>
    </div>
  )
}

function WorkFailureFilters({ state }: { state: DataTableState }) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="severity"
        label="Severity"
        allLabel="All severities"
        options={workFailureSeverityFilterOptions}
        triggerClassName="w-40"
      />
      <TableSelectFilter
        state={state}
        id="kind"
        label="Type"
        allLabel="All types"
        options={workFailureKindFilterOptions}
        triggerClassName="w-40"
      />
    </>
  )
}

export { HomePage }
export default HomePage
