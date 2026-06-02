import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, RotateCw } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useAgentSessions } from "@/features/control/api/queries"
import {
  humanize,
  mobileHiddenColumns,
  short,
  StatusBadge,
} from "@/features/control/control-display"
import { formatDate } from "@/features/control/formatting"
import {
  useCreateSessionSheet,
  useUpdateSessionSheet,
} from "@/features/control/forms/use-control-form-sheets"
import { sessionToFormValues } from "@/features/control/forms/form-values"
import {
  friendlySessionLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import { controlApi, type SessionRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const sessionKindFilterOptions = [
  { label: "Main", value: "main" },
  { label: "Branch", value: "branch" },
]

const sessionsDefaultColumnVisibility = {
  heartbeatEnabled: false,
}

export function SessionsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const createSessionSheet = useCreateSessionSheet()
  const updateSessionSheet = useUpdateSessionSheet()
  const table = useDataTableState(`agent:${agentKey}:sessions`, {
    sort_by: "updatedAt",
    sort_direction: "desc",
    columnVisibility: sessionsDefaultColumnVisibility,
  })
  const sessions = useAgentSessions(agentKey, table.params)
  const resetSession = useToastMutation({
    mutationFn: (session: SessionRow) =>
      controlApi.resetSession(agentKey, session.id, auth.csrfToken),
    success: "Session reset",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<SessionRow>[] = [
    {
      accessorKey: "label",
      meta: { label: "Session", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <SessionNameCell session={row.original} />,
    },
    {
      accessorKey: "kind",
      meta: { label: "Kind" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <Badge variant="outline">{humanize(row.original.kind)}</Badge>
      ),
    },
    {
      accessorKey: "updatedAt",
      meta: { label: "Updated", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.updatedAt)}</Cell>,
    },
    {
      accessorKey: "currentThreadId",
      meta: { label: "Thread", maxWidthClassName: "max-w-32" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <code title={row.original.currentThreadId ?? undefined}>
          {short(row.original.currentThreadId)}
        </code>
      ),
    },
    {
      accessorKey: "heartbeatEnabled",
      meta: { label: "Heartbeat" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <StatusBadge
          status={row.original.heartbeatEnabled ? "enabled" : "disabled"}
        />
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
          triggerLabel={`Open actions for session ${row.original.label}`}
          actions={[
            {
              label: "Edit",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                updateSessionSheet.setOpen(true, {
                  context: { agentKey },
                  defaultData: sessionToFormValues(row.original),
                  entity: row.original,
                }),
            },
            {
              destructive: true,
              label: "Reset session",
              icon: <RotateCw className="size-4" />,
              pending:
                resetSession.isPending &&
                resetSession.variables?.id === row.original.id,
              confirm: {
                title: "Reset session",
                description:
                  "This swaps the current thread while keeping the durable session.",
                confirmLabel: "Reset session",
                entityLabel: "Session",
                itemLabel: friendlySessionLabel(row.original),
              },
              onSelect: () => resetSession.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={sessions.data}
      state={table}
      defaultColumnVisibility={sessionsDefaultColumnVisibility}
      error={sessions.error}
      filters={<SessionKindFilter state={table} />}
      isFetching={sessions.isFetching}
      isLoading={sessions.isLoading}
      isPlaceholderData={sessions.isPlaceholderData}
      onRetry={() => void sessions.refetch()}
      rowKey={(row) => row.id}
      getLink={(row) =>
        `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(row.id)}`
      }
      emptyLabel="No sessions for this agent."
      emptyDescription="Create a main or branch session when this agent needs a durable runtime lane."
      mobileColumnVisibility={mobileHiddenColumns(
        "heartbeatEnabled",
        "currentThreadId",
        "updatedAt"
      )}
      toolbarActions={
        <Button
          size="sm"
          onClick={() =>
            createSessionSheet.setOpen(true, { context: { agentKey } })
          }
        >
          <Plus className="size-4" />
          New session
        </Button>
      }
    />
  )
}

function SessionKindFilter({ state }: { state: DataTableState }) {
  return (
    <TableSelectFilter
      state={state}
      id="kind"
      label="Kind"
      allLabel="All kinds"
      options={sessionKindFilterOptions}
    />
  )
}

function SessionNameCell({ session }: { session: SessionRow }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="truncate font-semibold">
        {friendlySessionLabel(session)}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {shortSessionId(session.id)}
      </span>
    </div>
  )
}
