import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, Trash2 } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  renderColumnHeader,
  type DataTableGlobalFilter,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useAgentSkills } from "@/features/control/api/queries"
import {
  TokenBadges,
  TruncatedText,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import { skillToFormValues } from "@/features/control/forms/form-values"
import { useSkillSheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi, type SkillRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"

export function SkillsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const skillSheet = useSkillSheet()
  const table = useDataTableState(`agent:${agentKey}:skills`)
  const skills = useAgentSkills(agentKey, table.params)
  const remove = useToastMutation({
    mutationFn: (skillKey: string) =>
      controlApi.deleteSkill(agentKey, skillKey, auth.csrfToken),
    success: "Skill deleted",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<SkillRow>[] = [
    {
      accessorKey: "skillKey",
      meta: { label: "Skill", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.skillKey}</Cell>,
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
      accessorKey: "tags",
      meta: { label: "Tags", wrap: true, maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => (
        <TokenBadges values={row.original.tags ?? []} className="max-w-64" />
      ),
    },
    {
      accessorKey: "agentEditable",
      meta: { label: "Agent edits" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <Badge variant={row.original.agentEditable ? "outline" : "secondary"}>
          {row.original.agentEditable ? "Allowed" : "Locked"}
        </Badge>
      ),
    },
    {
      accessorKey: "loadCount",
      meta: { label: "Loads", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.loadCount}</Cell>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for skill ${row.original.skillKey}`}
          actions={[
            {
              label: "Edit",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                skillSheet.setOpen(true, {
                  context: { agentKey },
                  defaultData: skillToFormValues(row.original),
                  entity: row.original,
                }),
            },
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Delete skill",
                description: `Delete ${row.original.skillKey}?`,
                confirmLabel: "Delete skill",
                entityLabel: "Skill",
                itemLabel: row.original.skillKey,
              },
              onSelect: () => remove.mutateAsync(row.original.skillKey),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={skills.data}
      state={table}
      error={skills.error}
      filters={<SkillFilters state={table} />}
      isFetching={skills.isFetching}
      isLoading={skills.isLoading}
      isPlaceholderData={skills.isPlaceholderData}
      onRetry={() => void skills.refetch()}
      rowKey={(row) => row.skillKey}
      emptyLabel="No skills configured for this agent."
      emptyDescription="Create reusable instructions or reference material that this agent can load when needed."
      mobileColumnVisibility={mobileHiddenColumns("description", "tags", "agentEditable")}
      toolbarActions={
        <Button
          size="sm"
          onClick={() => skillSheet.setOpen(true, { context: { agentKey } })}
        >
          <Plus className="size-4" />
          Create skill
        </Button>
      }
    />
  )
}

function SkillFilters({ state }: { state: DataTableState }) {
  const tag = String(state.globalFilter.tag ?? "")

  function setTag(value: string) {
    state.setGlobalFilter((previous: DataTableGlobalFilter) => {
      const next: DataTableGlobalFilter = { ...previous }
      if (value.trim()) next.tag = value
      else delete next.tag
      return next
    })
  }

  return (
    <Input
      className="h-8 w-44"
      value={tag}
      onChange={(event) => setTag(event.target.value)}
      placeholder="Filter by tag"
      aria-label="Filter skills by tag"
    />
  )
}
