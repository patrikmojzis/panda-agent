import type { ColumnDef } from "@tanstack/react-table"
import { Edit, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react"

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
import { useControlIdentities } from "@/features/control/api/queries"
import {
  StatusBadge,
  formatDate,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import {
  identityToFormValues,
  controlGrantDefaults,
} from "@/features/control/forms/form-values"
import { useControlGrantSheet, useIdentitySheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi, type IdentityOptionRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

const identityStatusOptions = [
  { label: "Active", value: "active" },
  { label: "Deleted", value: "deleted" },
]

const identitiesDefaultColumnVisibility = {
  id: false,
  actorBindingCount: false,
}

export function IdentitiesTable({ initialSearch = "" }: { initialSearch?: string }) {
  const auth = useAuth()
  const controlGrantSheet = useControlGrantSheet()
  const identitySheet = useIdentitySheet()
  const isAdmin = auth.session?.role === "admin"
  const table = useDataTableState("identities", {
    search: initialSearch,
    sort_by: "handle",
    sort_direction: "asc",
    columnVisibility: identitiesDefaultColumnVisibility,
  })
  const identities = useControlIdentities(table.params)
  const activate = useToastMutation({
    mutationFn: (row: IdentityOptionRow) =>
      controlApi.updateIdentity(
        row.id,
        { displayName: row.displayName, status: "active" },
        auth.csrfToken
      ),
    success: "Identity activated",
    invalidate: controlKeys.identities.all(),
  })
  const disable = useToastMutation({
    mutationFn: (row: IdentityOptionRow) =>
      controlApi.disableIdentity(row.id, auth.csrfToken),
    success: "Identity disabled",
    invalidate: controlKeys.identities.all(),
  })
  const columns: ColumnDef<IdentityOptionRow>[] = [
    {
      accessorKey: "handle",
      meta: { label: "Identity", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <Cell highlighted className="block min-w-0 truncate">
            {row.original.handle}
          </Cell>
          <Cell className="block min-w-0 truncate text-xs text-muted-foreground">
            {row.original.displayName}
          </Cell>
        </div>
      ),
    },
    {
      accessorKey: "status",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "agentPairingCount",
      meta: { label: "Agent pairings", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.agentPairingCount}</Cell>,
    },
    {
      accessorKey: "actorBindingCount",
      meta: { label: "Actor bindings", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.actorBindingCount}</Cell>,
    },
    {
      accessorKey: "id",
      meta: { label: "ID", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.id}</Cell>,
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
      cell: ({ row }) =>
        isAdmin ? (
          <RowActionsMenu
            triggerLabel={`Open actions for identity ${row.original.handle}`}
            actions={[
              {
                label: "Edit",
                icon: <Edit className="size-4" />,
                onSelect: () =>
                  identitySheet.setOpen(true, {
                    context: { agentKey: "" },
                    entity: row.original,
                    defaultData: identityToFormValues(row.original),
                  }),
              },
              {
                label: "Issue login token",
                icon: <KeyRound className="size-4" />,
                disabled: row.original.status !== "active",
                onSelect: () =>
                  controlGrantSheet.setOpen(true, {
                    context: { agentKey: "" },
                    defaultData: {
                      ...controlGrantDefaults,
                      identityId: row.original.id,
                    },
                  }),
              },
              row.original.status === "deleted"
                ? {
                    label: "Activate",
                    icon: <RotateCcw className="size-4" />,
                    pending: activate.isPending,
                    confirm: {
                      title: "Activate identity",
                      description:
                        "This allows the identity to be selected in Control pairing flows again.",
                      confirmLabel: "Activate identity",
                      entityLabel: "Identity",
                      itemLabel: row.original.handle,
                    },
                    onSelect: () => activate.mutateAsync(row.original),
                  }
                : {
                    label: "Disable",
                    icon: <Trash2 className="size-4" />,
                    destructive: true,
                    pending: disable.isPending,
                    confirm: {
                      title: "Disable identity",
                      description:
                        "This prevents the identity from being selected in new pairing flows. Existing pairings are not deleted.",
                      confirmLabel: "Disable identity",
                      entityLabel: "Identity",
                      itemLabel: row.original.handle,
                    },
                    onSelect: () => disable.mutateAsync(row.original),
                  },
            ]}
          />
        ) : (
          <span className="sr-only">No actions available</span>
        ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={identities.data}
      state={table}
      defaultColumnVisibility={identitiesDefaultColumnVisibility}
      error={identities.error}
      filters={<IdentityFilters state={table} />}
      isFetching={identities.isFetching}
      isLoading={identities.isLoading}
      isPlaceholderData={identities.isPlaceholderData}
      onRetry={() => void identities.refetch()}
      rowKey={(row) => row.id}
      emptyLabel="No identities."
      emptyDescription={
        isAdmin
          ? "Create an identity before pairing it to agents or channel actors."
          : "No identities are visible in your current Control scope."
      }
      mobileColumnVisibility={mobileHiddenColumns(
        "agentPairingCount",
        "actorBindingCount",
        "id",
        "updatedAt"
      )}
      toolbarActions={
        isAdmin ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => controlGrantSheet.setOpen(true, { context: { agentKey: "" } })}
            >
              <KeyRound className="size-4" />
              Issue token
            </Button>
            <Button size="sm" onClick={() => identitySheet.setOpen(true)}>
              <Plus className="size-4" />
              Create identity
            </Button>
          </>
        ) : null
      }
    />
  )
}

function IdentityFilters({ state }: { state: DataTableState }) {
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
