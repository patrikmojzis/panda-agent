import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, Trash2 } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  renderColumnHeader,
  useDataTableState,
} from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useAgentCredentials } from "@/features/control/api/queries"
import {
  formatDate,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import { useCredentialSheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi, type CredentialRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

export function CredentialsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const credentialSheet = useCredentialSheet()
  const table = useDataTableState(`agent:${agentKey}:credentials`)
  const credentials = useAgentCredentials(agentKey, table.params)
  const deleteCredential = useToastMutation({
    mutationFn: (envKey: string) =>
      controlApi.deleteCredential(agentKey, envKey, auth.csrfToken),
    success: "Credential deleted",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<CredentialRow>[] = [
    {
      accessorKey: "envKey",
      meta: { label: "Key", maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.envKey}</Cell>,
    },
    {
      accessorKey: "present",
      meta: { label: "Value" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: () => <Badge variant="secondary">write-only</Badge>,
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
          triggerLabel={`Open actions for credential ${row.original.envKey}`}
          actions={[
            {
              label: "Edit",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                credentialSheet.setOpen(true, {
                  context: { agentKey },
                  defaultData: { envKey: row.original.envKey, value: "" },
                  entity: row.original,
                }),
            },
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: deleteCredential.isPending,
              confirm: {
                title: "Delete credential",
                description: `Delete ${row.original.envKey}? Secret values cannot be recovered from Control.`,
                confirmLabel: "Delete credential",
                entityLabel: "Credential",
                itemLabel: row.original.envKey,
              },
              onSelect: () => deleteCredential.mutateAsync(row.original.envKey),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={credentials.data}
      state={table}
      error={credentials.error}
      isFetching={credentials.isFetching}
      isLoading={credentials.isLoading}
      isPlaceholderData={credentials.isPlaceholderData}
      onRetry={() => void credentials.refetch()}
      rowKey={(row) => row.envKey}
      emptyLabel="No credentials stored for this agent."
      emptyDescription="Store write-only secrets for this agent. Control never renders saved secret values."
      mobileColumnVisibility={mobileHiddenColumns("present")}
      toolbarActions={
        <Button
          size="sm"
          onClick={() =>
            credentialSheet.setOpen(true, { context: { agentKey } })
          }
        >
          <Plus className="size-4" />
          Store credential
        </Button>
      }
    />
  )
}
