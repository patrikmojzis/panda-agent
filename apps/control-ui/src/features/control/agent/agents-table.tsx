import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink } from "lucide-react"
import { useNavigate } from "react-router-dom"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  renderColumnHeader,
  useDataTableState,
} from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { useAgents } from "@/features/control/api/queries"
import {
  mobileHiddenColumns,
  StatusBadge,
} from "@/features/control/control-display"
import type { AgentRow } from "@/lib/api"

const agentsDefaultColumnVisibility = {
  paired: false,
}

export function AgentsTable({ initialSearch = "" }: { initialSearch?: string }) {
  const navigate = useNavigate()
  const table = useDataTableState("agents", {
    search: initialSearch,
    sort_by: "agentKey",
    sort_direction: "asc",
    columnVisibility: agentsDefaultColumnVisibility,
  })
  const agents = useAgents(table.params)
  const columns: ColumnDef<AgentRow>[] = [
    {
      accessorKey: "agentKey",
      meta: { label: "Agent", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.agentKey}</Cell>,
    },
    {
      accessorKey: "displayName",
      meta: { label: "Name", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.displayName}</Cell>,
    },
    {
      accessorKey: "status",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "sessionCount",
      meta: { label: "Sessions", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.sessionCount}</Cell>,
    },
    {
      accessorKey: "paired",
      meta: { label: "Pairing" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) =>
        row.original.paired ? (
          <Badge>Paired</Badge>
        ) : (
          <Badge variant="outline">Admin visible</Badge>
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
          triggerLabel={`Open actions for agent ${row.original.agentKey}`}
          actions={[
            {
              label: "Open agent",
              icon: <ExternalLink className="size-4" />,
              onSelect: () =>
                navigate(
                  `/agents/${encodeURIComponent(row.original.agentKey)}`
                ),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={agents.data}
      state={table}
      defaultColumnVisibility={agentsDefaultColumnVisibility}
      error={agents.error}
      isFetching={agents.isFetching}
      isLoading={agents.isLoading}
      isPlaceholderData={agents.isPlaceholderData}
      onRetry={() => void agents.refetch()}
      rowKey={(row) => row.agentKey}
      getLink={(row) => `/agents/${encodeURIComponent(row.agentKey)}`}
      emptyLabel="No visible agents."
      mobileColumnVisibility={mobileHiddenColumns("displayName", "paired")}
    />
  )
}
