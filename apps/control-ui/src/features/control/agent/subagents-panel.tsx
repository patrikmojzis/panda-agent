import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableMultiSelectFilter,
  TableSelectFilter,
  booleanFilterValueSetter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useAgentSubagents } from "@/features/control/api/queries"
import {
  StatusBadge,
  TokenBadges,
  TruncatedText,
  enabledFilterOptions,
  humanize,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import {
  subagentSourceFilterOptions,
  subagentToolGroupOptions,
} from "@/features/control/agent/subagent-options"
import { subagentToFormValues } from "@/features/control/forms/form-values"
import { useSubagentSheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi, type SubagentRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

export function SubagentsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const subagentSheet = useSubagentSheet()
  const table = useDataTableState(`agent:${agentKey}:subagents`, {
    filterValueSetters: { enabled: booleanFilterValueSetter },
  })
  const subagents = useAgentSubagents(agentKey, table.params)
  const setEnabled = useToastMutation({
    mutationFn: ({ slug, enabled }: { slug: string; enabled: boolean }) =>
      controlApi.setSubagentEnabled(agentKey, slug, enabled, auth.csrfToken),
    success: "Subagent updated",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<SubagentRow>[] = [
    {
      accessorKey: "slug",
      meta: { label: "Slug", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.slug}</Cell>,
    },
    {
      accessorKey: "description",
      meta: { label: "Description", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText
          value={row.original.description}
          className="max-w-72"
        />
      ),
    },
    {
      accessorKey: "toolGroups",
      meta: { label: "Tools", wrap: true, maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => (
        <TokenBadges values={row.original.toolGroups} className="max-w-64" />
      ),
    },
    {
      accessorKey: "source",
      meta: { label: "Source", maxWidthClassName: "max-w-32" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{humanize(row.original.source)}</Cell>,
    },
    {
      accessorKey: "enabled",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <StatusBadge status={row.original.enabled ? "enabled" : "disabled"} />
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => {
        const enabled = row.original.enabled
        return (
          <RowActionsMenu
            triggerLabel={`Open actions for subagent ${row.original.slug}`}
            actions={[
              {
                label: "Edit",
                icon: <Pencil className="size-4" />,
                onSelect: () =>
                  subagentSheet.setOpen(true, {
                    context: { agentKey },
                    defaultData: subagentToFormValues(row.original),
                    entity: row.original,
                  }),
              },
              {
                label: enabled ? "Disable subagent" : "Enable subagent",
                disabled: setEnabled.isPending,
                pending: setEnabled.isPending,
                destructive: enabled,
                confirm: {
                  title: enabled ? "Disable subagent" : "Enable subagent",
                  description: `${enabled ? "Disable" : "Enable"} ${row.original.slug} for this agent.`,
                  confirmLabel: enabled
                    ? "Disable subagent"
                    : "Enable subagent",
                  entityLabel: "Subagent",
                  itemLabel: row.original.slug,
                },
                onSelect: () =>
                  setEnabled.mutateAsync({
                    slug: row.original.slug,
                    enabled: !enabled,
                  }),
              },
            ]}
          />
        )
      },
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={subagents.data}
      state={table}
      error={subagents.error}
      filters={<SubagentFilters state={table} />}
      isFetching={subagents.isFetching}
      isLoading={subagents.isLoading}
      isPlaceholderData={subagents.isPlaceholderData}
      onRetry={() => void subagents.refetch()}
      rowKey={(row) => row.slug}
      emptyLabel="No subagent profiles for this agent."
      emptyDescription="Create delegation profiles for specialized work this agent should hand off."
      mobileColumnVisibility={mobileHiddenColumns(
        "description",
        "toolGroups",
        "source"
      )}
      toolbarActions={
        <Button
          size="sm"
          onClick={() => subagentSheet.setOpen(true, { context: { agentKey } })}
        >
          <Plus className="size-4" />
          Create subagent
        </Button>
      }
    />
  )
}

function SubagentFilters({ state }: { state: DataTableState }) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="enabled"
        label="Status"
        allLabel="All statuses"
        options={enabledFilterOptions}
        triggerClassName="w-36"
      />
      <TableSelectFilter
        state={state}
        id="source"
        label="Source"
        allLabel="All sources"
        options={subagentSourceFilterOptions}
        triggerClassName="w-36"
      />
      <TableMultiSelectFilter
        state={state}
        id="toolGroups"
        label="Tools"
        allLabel="All tool groups"
        options={subagentToolGroupOptions}
        triggerClassName="w-44"
      />
    </>
  )
}
