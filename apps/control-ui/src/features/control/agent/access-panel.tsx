import type { ColumnDef } from "@tanstack/react-table"
import { Plus, Trash2 } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useAgentPairings } from "@/features/control/api/queries"
import {
  StatusBadge,
  formatDate,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import {
  useAgentPairingSheet,
  useIdentitySheet,
} from "@/features/control/forms/use-control-form-sheets"
import { controlApi, type AgentPairingRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const identityStatusOptions = [
  { label: "Active", value: "active" },
  { label: "Deleted", value: "deleted" },
]

export function AccessPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const pairingSheet = useAgentPairingSheet()
  const identitySheet = useIdentitySheet()
  const isAdmin = auth.session?.role === "admin"
  const table = useDataTableState(`agent:${agentKey}:access-pairings`, {
    sort_by: "identityHandle",
    sort_direction: "asc",
  })
  const pairings = useAgentPairings(agentKey, table.params)
  const remove = useToastMutation({
    mutationFn: (row: AgentPairingRow) =>
      controlApi.deleteAgentPairing(agentKey, row, auth.csrfToken),
    success: "Identity unpaired",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<AgentPairingRow>[] = [
    {
      accessorKey: "identityHandle",
      meta: { label: "Identity", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <Cell highlighted className="block min-w-0 truncate">
            {row.original.identityHandle}
          </Cell>
          <Cell className="block min-w-0 truncate text-xs text-muted-foreground">
            {row.original.identityDisplayName}
          </Cell>
        </div>
      ),
    },
    {
      accessorKey: "identityStatus",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.identityStatus} />,
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
          triggerLabel={`Open actions for identity ${row.original.identityHandle}`}
          actions={[
            {
              label: "Unpair",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Unpair identity",
                description: `Unpair ${row.original.identityHandle} from this agent? Scoped access and channel actor routing through this pairing will stop working.`,
                confirmLabel: "Unpair identity",
                entityLabel: "Identity",
                itemLabel: row.original.identityHandle,
              },
              onSelect: () => remove.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={pairings.data}
      state={table}
      error={pairings.error}
      filters={<AccessFilters state={table} />}
      isFetching={pairings.isFetching}
      isLoading={pairings.isLoading}
      isPlaceholderData={pairings.isPlaceholderData}
      onRetry={() => void pairings.refetch()}
      rowKey={(row) => row.identityId}
      emptyLabel="No identities paired with this agent."
      emptyDescription="Pair an identity before scoped operators or channel actors can reach this agent."
      mobileColumnVisibility={mobileHiddenColumns("identityStatus")}
      toolbarActions={
        <>
          {isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => identitySheet.setOpen(true)}
            >
              <Plus className="size-4" />
              Create identity
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => pairingSheet.setOpen(true, { context: { agentKey } })}
          >
            <Plus className="size-4" />
            Pair identity
          </Button>
        </>
      }
    />
  )
}

function AccessFilters({ state }: { state: DataTableState }) {
  return (
    <TableSelectFilter
      state={state}
      id="status"
      label="Status"
      allLabel="Any status"
      options={identityStatusOptions}
    />
  )
}
