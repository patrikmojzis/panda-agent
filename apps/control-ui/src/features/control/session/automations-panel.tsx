import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, Trash2 } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  booleanFilterValueSetter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useScheduledTasks } from "@/features/control/api/queries"
import {
  enabledFilterOptions,
  formatDate,
  formatSchedule,
  Metric,
  mobileHiddenColumns,
  short,
  StatusBadge,
  TruncatedText,
} from "@/features/control/control-display"
import { scheduledTaskToFormValues } from "@/features/control/forms/form-values"
import { useScheduledTaskSheet } from "@/features/control/forms/use-control-form-sheets"
import type { ScheduledTask, ScheduledTasks } from "@/lib/api"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const scheduledTaskStatusFilterOptions = [
  { label: "Scheduled", value: "scheduled" },
  { label: "Disabled", value: "disabled" },
  { label: "Running", value: "running" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
]

export function AutomationsPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const table = useDataTableState(
    `agent:${agentKey}:session:${sessionId}:scheduled-tasks`,
    {
      per_page: 10,
      sort_by: "nextFireAt",
      sort_direction: "asc",
      filterValueSetters: { enabled: booleanFilterValueSetter },
    }
  )
  const tasks = useScheduledTasks(agentKey, sessionId, table.params)
  const rawResponse = tasks.data?.scheduledTasks
  const rows = rawResponse?.data ?? rawResponse?.tasks ?? []
  const response = rawResponse
    ? ({
        ...rawResponse,
        data: rows,
        tasks: rawResponse.tasks ?? rows,
        meta: rawResponse.meta ?? {
          current_page: table.pagination.pageIndex + 1,
          last_page: 1,
          per_page: table.pagination.pageSize,
          total: rows.length,
        },
      } satisfies ScheduledTasks)
    : undefined
  const total = response?.meta.total ?? 0
  const pageEnabled = rows.filter((task) => task.enabled).length
  const pageRunning = rows.filter(
    (task) => task.lifecycleStatus === "running"
  ).length
  const pageFailedRuns = rows.reduce(
    (count, task) =>
      count + task.recentRuns.filter((run) => run.status === "failed").length,
    0
  )

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Filtered tasks" value={total} />
        <Metric label="Page enabled" value={pageEnabled} />
        <Metric label="Page running" value={pageRunning} />
        <Metric label="Page failed recent runs" value={pageFailedRuns} />
      </div>
      <ScheduledTasksTable
        agentKey={agentKey}
        sessionId={sessionId}
        table={table}
        response={response}
        loading={tasks.isLoading}
        fetching={tasks.isFetching}
        placeholder={tasks.isPlaceholderData}
        error={tasks.error}
      />
    </div>
  )
}

function ScheduledTasksTable({
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
  response?: ScheduledTasks
  loading?: boolean
  fetching?: boolean
  placeholder?: boolean
  error?: unknown
}) {
  const auth = useAuth()
  const scheduledTaskSheet = useScheduledTaskSheet()
  const cancel = useToastMutation({
    mutationFn: (task: ScheduledTask) =>
      controlApi.cancelScheduledTask(
        agentKey,
        sessionId,
        task.id,
        "Cancelled from Control UI",
        auth.csrfToken
      ),
    success: "Automation cancelled",
    invalidate: controlKeys.sessions.scheduledTasks(agentKey, sessionId),
  })
  function openCreateAutomation() {
    scheduledTaskSheet.setOpen(true, {
      context: { agentKey, sessionId },
    })
  }
  const columns: ColumnDef<ScheduledTask>[] = [
    {
      accessorKey: "title",
      meta: { label: "Automation", wrap: true, maxWidthClassName: "max-w-80" },
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
      accessorKey: "enabled",
      meta: { label: "Enabled" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <StatusBadge status={row.original.enabled ? "enabled" : "disabled"} />
      ),
    },
    {
      id: "schedule",
      accessorFn: (row) => formatSchedule(row.schedule),
      meta: { label: "Schedule", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText value={formatSchedule(row.original.schedule)} />
      ),
    },
    {
      accessorKey: "nextFireAt",
      meta: { label: "Next fire", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.nextFireAt)}</Cell>,
    },
    {
      id: "recentRuns",
      meta: { label: "Recent runs", wrap: true, maxWidthClassName: "max-w-80" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => <RecentRuns runs={row.original.recentRuns} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for automation ${row.original.title}`}
          actions={[
            {
              label: "Edit",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                scheduledTaskSheet.setOpen(true, {
                  context: { agentKey, sessionId },
                  defaultData: scheduledTaskToFormValues(row.original),
                  entity: row.original,
                }),
            },
            {
              label: "Cancel",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              disabled: row.original.lifecycleStatus === "cancelled",
              pending: cancel.isPending,
              confirm: {
                title: "Cancel automation",
                description: `Cancel ${row.original.title}? Future wakeups for this automation will stop.`,
                confirmLabel: "Cancel automation",
                entityLabel: "Automation",
                itemLabel: row.original.title,
              },
              onSelect: () => cancel.mutateAsync(row.original),
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
        <ScheduledTaskFilters
          state={table}
          statusOptions={scheduledTaskStatusFilterOptions}
        />
      }
      isLoading={loading}
      isFetching={fetching}
      isPlaceholderData={placeholder}
      rowKey={(row) => row.id}
      emptyLabel="No scheduled automations for this session."
      emptyDescription="Create one when this session should wake itself on a schedule."
      emptyAction={
        <Button size="sm" onClick={openCreateAutomation}>
          <Plus className="size-4" />
          Create automation
        </Button>
      }
      mobileColumnVisibility={mobileHiddenColumns(
        "enabled",
        "schedule",
        "recentRuns"
      )}
      toolbarActions={
        <Button size="sm" onClick={openCreateAutomation}>
          <Plus className="size-4" />
          Create automation
        </Button>
      }
    />
  )
}

function ScheduledTaskFilters({
  state,
  statusOptions,
}: {
  state: DataTableState
  statusOptions: Array<{ label: string; value: string }>
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
        id="enabled"
        label="Enabled"
        allLabel="All states"
        options={enabledFilterOptions}
        triggerClassName="w-36"
      />
    </>
  )
}

function RecentRuns({ runs }: { runs: ScheduledTask["recentRuns"] }) {
  if (runs.length === 0)
    return <span className="text-muted-foreground">No recent runs</span>

  return (
    <div className="grid gap-1">
      {runs.slice(0, 3).map((run) => (
        <div key={run.id} className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <span className="text-muted-foreground tabular-nums">
            {formatDate(run.scheduledFor) ?? "-"}
          </span>
        </div>
      ))}
    </div>
  )
}
