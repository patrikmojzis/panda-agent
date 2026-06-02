import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { GitBranch, Plus, Trash2 } from "lucide-react"

import { sessionPath } from "@/app/control-routes"
import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  useDataTableState,
  type DataTableState,
} from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useA2ABindings } from "@/features/control/api/queries"
import {
  TruncatedText,
  formatDate,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import { useA2ABindingSheet } from "@/features/control/forms/use-control-form-sheets"
import {
  sessionReferenceLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import { controlApi, type A2ABindingRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const directionFilterOptions = [
  { label: "Outbound", value: "outbound" },
  { label: "Inbound", value: "inbound" },
]

export function A2ABindingsPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const auth = useAuth()
  const sheet = useA2ABindingSheet()
  const table = useDataTableState(`agent:${agentKey}:session:${sessionId}:a2a`)
  const bindings = useA2ABindings(agentKey, sessionId, table.params)
  const remove = useToastMutation({
    mutationFn: (row: A2ABindingRow) =>
      controlApi.deleteA2ABinding(
        agentKey,
        sessionId,
        peerSessionId(row),
        { direction: row.direction, oneWay: false },
        auth.csrfToken
      ),
    success: "A2A binding removed",
    invalidate: controlKeys.agents.session(agentKey, sessionId),
  })
  const columns = React.useMemo<ColumnDef<A2ABindingRow>[]>(
    () => [
      {
        accessorKey: "direction",
        meta: { label: "Direction", maxWidthClassName: "max-w-32" },
        header: renderColumnHeader,
        enableSorting: true,
        enableHiding: false,
        cell: ({ row }) => (
          <Badge variant={row.original.direction === "outbound" ? "outline" : "secondary"}>
            {row.original.direction === "outbound" ? "Outbound" : "Inbound"}
          </Badge>
        ),
      },
      {
        id: "peer",
        meta: { label: "Peer session", maxWidthClassName: "max-w-96" },
        header: renderColumnHeader,
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => <PeerSessionCell row={row.original} />,
      },
      {
        accessorKey: "senderSessionLabel",
        meta: { label: "Sender", maxWidthClassName: "max-w-80" },
        header: renderColumnHeader,
        enableSorting: true,
        cell: ({ row }) => (
          <SessionEndpointCell
            agentKey={row.original.senderAgentKey}
            sessionId={row.original.senderSessionId}
            label={row.original.senderSessionLabel}
          />
        ),
      },
      {
        accessorKey: "recipientSessionLabel",
        meta: { label: "Recipient", maxWidthClassName: "max-w-80" },
        header: renderColumnHeader,
        enableSorting: true,
        cell: ({ row }) => (
          <SessionEndpointCell
            agentKey={row.original.recipientAgentKey}
            sessionId={row.original.recipientSessionId}
            label={row.original.recipientSessionLabel}
          />
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
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        meta: { linkEnabled: false, align: "right" },
        cell: ({ row }) => (
          <RowActionsMenu
            triggerLabel={`Open actions for A2A binding with ${peerLabel(row.original)}`}
            actions={[
              {
                label: "Delete",
                icon: <Trash2 className="size-4" />,
                destructive: true,
                pending: remove.isPending,
                confirm: {
                  title: "Delete A2A binding",
                  description:
                    "This removes the selected session route and its reciprocal route when one exists.",
                  confirmLabel: "Delete binding",
                  entityLabel: "A2A binding",
                  itemLabel: peerLabel(row.original),
                },
                onSelect: () => remove.mutateAsync(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [remove]
  )

  return (
    <section className="grid min-w-0 gap-3">
      <DataTableView
        columns={columns}
        response={bindings.data}
        state={table}
        error={bindings.error}
        filters={<A2ABindingFilters state={table} />}
        getLink={(row) =>
          sessionPath(peerAgentKey(row), peerSessionId(row))
        }
        isFetching={bindings.isFetching}
        isLoading={bindings.isLoading}
        isPlaceholderData={bindings.isPlaceholderData}
        onRetry={() => void bindings.refetch()}
        rowKey={(row) =>
          `${row.senderSessionId}:${row.recipientSessionId}:${row.direction}`
        }
        emptyLabel="No A2A bindings for this session."
        emptyDescription="Bind another visible session before agents can message each other directly."
        emptyAction={
          <Button size="sm" onClick={openSheet}>
            <Plus className="size-4" />
            Bind session
          </Button>
        }
        mobileColumnVisibility={mobileHiddenColumns(
          "senderSessionLabel",
          "recipientSessionLabel",
          "updatedAt"
        )}
        toolbarActions={
          <Button size="sm" onClick={openSheet}>
            <Plus className="size-4" />
            Bind session
          </Button>
        }
      />
    </section>
  )

  function openSheet() {
    sheet.setOpen(true, { context: { agentKey, sessionId } })
  }
}

function A2ABindingFilters({ state }: { state: DataTableState }) {
  return (
    <TableSelectFilter
      state={state}
      id="direction"
      label="Direction"
      allLabel="All directions"
      options={directionFilterOptions}
    />
  )
}

function PeerSessionCell({ row }: { row: A2ABindingRow }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="truncate font-medium">{peerLabel(row)}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate">{row.direction === "outbound" ? "Current session sends to peer" : "Peer sends to current session"}</span>
      </span>
    </div>
  )
}

function SessionEndpointCell({
  agentKey,
  label,
  sessionId,
}: {
  agentKey: string
  label: string
  sessionId: string
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <TruncatedText value={sessionReferenceLabel(label, sessionId)} className="font-medium text-foreground" />
      <span className="truncate text-xs text-muted-foreground">
        {agentKey} · {shortSessionId(sessionId)}
      </span>
    </div>
  )
}

function peerAgentKey(row: A2ABindingRow) {
  return row.direction === "outbound"
    ? row.recipientAgentKey
    : row.senderAgentKey
}

function peerSessionId(row: A2ABindingRow) {
  return row.direction === "outbound"
    ? row.recipientSessionId
    : row.senderSessionId
}

function peerLabel(row: A2ABindingRow) {
  const label =
    row.direction === "outbound"
      ? row.recipientSessionLabel
      : row.senderSessionLabel
  return `${label} · ${peerAgentKey(row)} · ${shortSessionId(peerSessionId(row))}`
}
