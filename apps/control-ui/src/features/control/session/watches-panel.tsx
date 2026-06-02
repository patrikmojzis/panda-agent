import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Power, PowerOff } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useWatches } from "@/features/control/api/queries"
import {
  formatDate,
  humanize,
  Metric,
  mobileHiddenColumns,
  short,
  StatusBadge,
} from "@/features/control/control-display"
import { watchConfigToFormValues } from "@/features/control/forms/form-values"
import { useWatchConfigSheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi, type Watches, type WatchRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const watchStatusFilterOptions = [
  { label: "Enabled", value: "enabled" },
  { label: "Disabled", value: "disabled" },
  { label: "Cooldown", value: "cooldown" },
  { label: "Running", value: "running" },
]

const watchSourceFilterOptions = [
  { label: "HTTP JSON", value: "http_json" },
  { label: "HTTP HTML", value: "http_html" },
  { label: "IMAP Mailbox", value: "imap_mailbox" },
  { label: "MongoDB Query", value: "mongodb_query" },
  { label: "SQL Query", value: "sql_query" },
]

export function WatchesPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const table = useDataTableState(`agent:${agentKey}:session:${sessionId}:watches`, {
    per_page: 10,
    sort_by: "nextPollAt",
    sort_direction: "asc",
  })
  const watches = useWatches(agentKey, sessionId, table.params)
  const rawResponse = watches.data?.watches
  const rows = rawResponse?.data ?? rawResponse?.watches ?? []
  const response = rawResponse
    ? ({
        ...rawResponse,
        data: rows,
        watches: rawResponse.watches ?? rows,
        meta: rawResponse.meta ?? {
          current_page: table.pagination.pageIndex + 1,
          last_page: 1,
          per_page: table.pagination.pageSize,
          total: rows.length,
        },
      } satisfies Watches)
    : undefined
  const total = response?.meta.total ?? 0
  const pageEnabled = rows.filter((watch) => watch.enabled).length
  const pageEvents = rows.reduce((count, watch) => count + watch.eventCount, 0)
  const pageRecentRuns = rows.reduce(
    (count, watch) => count + watch.recentRunCount,
    0
  )

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Filtered watches" value={total} />
        <Metric label="Page enabled" value={pageEnabled} />
        <Metric label="Page events" value={pageEvents} />
        <Metric label="Page recent runs" value={pageRecentRuns} />
      </div>
      <WatchesTable
        agentKey={agentKey}
        sessionId={sessionId}
        table={table}
        response={response}
        loading={watches.isLoading}
        fetching={watches.isFetching}
        placeholder={watches.isPlaceholderData}
        error={watches.error}
      />
    </div>
  )
}

function WatchesTable({
  agentKey,
  sessionId,
  table,
  response,
  loading,
  fetching,
  placeholder,
  error,
}: {
  agentKey: string
  sessionId: string
  table: DataTableState
  response?: Watches
  loading?: boolean
  fetching?: boolean
  placeholder?: boolean
  error?: unknown
}) {
  const auth = useAuth()
  const watchConfigSheet = useWatchConfigSheet()
  const enable = useToastMutation({
    mutationFn: (watch: WatchRow) =>
      controlApi.updateWatch(
        agentKey,
        sessionId,
        watch.id,
        { enabled: true },
        auth.csrfToken
      ),
    success: "Watch enabled",
    invalidate: controlKeys.sessions.watches(agentKey, sessionId),
  })
  const disable = useToastMutation({
    mutationFn: (watch: WatchRow) =>
      controlApi.disableWatch(
        agentKey,
        sessionId,
        watch.id,
        "Disabled from Control UI",
        auth.csrfToken
      ),
    success: "Watch disabled",
    invalidate: controlKeys.sessions.watches(agentKey, sessionId),
  })
  const columns: ColumnDef<WatchRow>[] = [
    {
      accessorKey: "title",
      meta: { label: "Watch", wrap: true, maxWidthClassName: "max-w-80" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <div className="grid min-w-0 gap-1">
          <span className="truncate font-medium" title={row.original.title}>
            {row.original.title}
          </span>
          <span className="truncate text-muted-foreground">
            {short(row.original.id)}
          </span>
        </div>
      ),
    },
    {
      accessorKey: "lifecycleStatus",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.lifecycleStatus} />,
    },
    {
      id: "source",
      accessorFn: (row) =>
        `${row.sourceKind ?? ""} ${row.observationKind ?? ""}`,
      meta: { label: "Source", wrap: true, maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <div className="grid min-w-0 gap-1">
          <span className="truncate">{humanize(row.original.sourceKind)}</span>
          <span className="truncate text-muted-foreground">
            {humanize(row.original.observationKind)}
          </span>
        </div>
      ),
    },
    {
      accessorKey: "detectorKind",
      meta: { label: "Detector" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{humanize(row.original.detectorKind)}</Cell>,
    },
    {
      accessorKey: "intervalMinutes",
      meta: { label: "Interval", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{`${row.original.intervalMinutes}m`}</Cell>,
    },
    {
      accessorKey: "nextPollAt",
      meta: { label: "Next poll", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.nextPollAt)}</Cell>,
    },
    {
      id: "activity",
      accessorFn: (row) => row.eventCount + row.recentRunCount,
      meta: { label: "Activity", wrap: true, maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <div className="grid min-w-0 gap-1">
          <span className="truncate tabular-nums">{row.original.eventCount} events</span>
          <span className="truncate text-muted-foreground">
            {row.original.recentRunCount} runs -{" "}
            {row.original.latestRun
              ? humanize(row.original.latestRun.status)
              : "No runs"}
          </span>
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for watch ${row.original.title}`}
          actions={[
            {
              label: "Edit config",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                watchConfigSheet.setOpen(true, {
                  context: { agentKey, sessionId },
                  defaultData: watchConfigToFormValues(row.original),
                  entity: row.original,
                }),
            },
            row.original.enabled
              ? {
                  label: "Disable",
                  icon: <PowerOff className="size-4" />,
                  destructive: true,
                  pending: disable.isPending,
                  confirm: {
                    title: "Disable watch",
                    description: `Disable ${row.original.title}? The watch remains configured but stops polling.`,
                    confirmLabel: "Disable watch",
                    entityLabel: "Watch",
                    itemLabel: row.original.title,
                  },
                  onSelect: () => disable.mutateAsync(row.original),
                }
              : {
                  label: "Enable",
                  icon: <Power className="size-4" />,
                  pending: enable.isPending,
                  confirm: {
                    title: "Enable watch",
                    description: `Enable ${row.original.title}? Polling will resume on its configured interval.`,
                    confirmLabel: "Enable watch",
                    entityLabel: "Watch",
                    itemLabel: row.original.title,
                  },
                  onSelect: () => enable.mutateAsync(row.original),
                },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={response}
      state={table}
      error={error}
      filters={
        <WatchFilters
          state={table}
          statusOptions={watchStatusFilterOptions}
          sourceOptions={watchSourceFilterOptions}
        />
      }
      isLoading={loading}
      isFetching={fetching}
      isPlaceholderData={placeholder}
      rowKey={(row) => row.id}
      emptyLabel="No watches for this session."
      emptyDescription="Watches are created by runtime tools. Control edits, enables, or disables existing watch config once it exists."
      mobileColumnVisibility={mobileHiddenColumns(
        "source",
        "detectorKind",
        "intervalMinutes",
        "activity"
      )}
    />
  )
}

function WatchFilters({
  state,
  statusOptions,
  sourceOptions,
}: {
  state: DataTableState
  statusOptions: Array<{ label: string; value: string }>
  sourceOptions: Array<{ label: string; value: string }>
}) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="lifecycleStatus"
        label="Status"
        allLabel="All statuses"
        options={statusOptions}
        triggerClassName="w-36"
      />
      <TableSelectFilter
        state={state}
        id="sourceKind"
        label="Source"
        allLabel="All sources"
        options={sourceOptions}
        triggerClassName="w-40"
      />
    </>
  )
}
