import { Pencil, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { useBriefing } from "@/features/control/api/queries"
import { ConfirmButton } from "@/features/control/confirm-actions"
import {
  DetailField,
  DetailPanel,
  TableError,
} from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/formatting"
import { briefingDefaults, briefingToFormValues } from "@/features/control/forms/form-values"
import { useBriefingSheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

export function BriefingPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const auth = useAuth()
  const briefingSheet = useBriefingSheet()
  const briefing = useBriefing(agentKey, sessionId)
  const record = briefing.data?.briefing
  const savedContent = record?.content ?? ""
  const clear = useToastMutation({
    mutationFn: () =>
      controlApi.deleteBriefing(agentKey, sessionId, auth.csrfToken),
    success: "Briefing cleared",
    invalidate: controlKeys.agents.session(agentKey, sessionId),
  })
  const trimmedContent = savedContent.trim()
  const isSet = Boolean(record?.wasSet && trimmedContent)
  const canClear = Boolean(record?.wasSet) && !clear.isPending
  if (briefing.error) return <TableError error={briefing.error} />

  function openBriefingSheet() {
    briefingSheet.setOpen(true, {
      context: { agentKey, sessionId },
      defaultData: record ? briefingToFormValues(record) : briefingDefaults,
      entity: record,
    })
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <DetailPanel
        title="Session Briefing"
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={briefing.isLoading}
              size="sm"
              variant={isSet ? "outline" : "default"}
              onClick={openBriefingSheet}
            >
              {isSet ? <Pencil className="size-4" /> : <Plus className="size-4" />}
              {isSet ? "Edit" : "Add"}
            </Button>
            {record?.wasSet ? (
              <ConfirmButton
                disabled={!canClear}
                title="Clear briefing"
                description="Remove the durable session briefing."
                confirmLabel="Clear briefing"
                entityLabel="Session"
                itemLabel={sessionId}
                onConfirm={() => clear.mutateAsync(undefined)}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                {clear.isPending ? "Clearing" : "Clear"}
              </ConfirmButton>
            ) : null}
          </div>
        }
      >
        <div className="grid gap-3">
          {briefing.isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : isSet ? (
            <div className="max-h-[32rem] overflow-auto border bg-muted/20 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
              {savedContent}
            </div>
          ) : (
            <div className="border border-dashed bg-muted/10 p-6 text-sm text-muted-foreground">
              No briefing is set for this session.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={isSet ? "outline" : "secondary"}>
              {isSet ? "Set" : "Empty"}
            </Badge>
            <span>{trimmedContent.length.toLocaleString()} chars</span>
          </div>
        </div>
      </DetailPanel>
      <DetailPanel title="Briefing State">
        <div className="grid gap-3">
          <DetailField
            loading={briefing.isLoading}
            label="Status"
            value={isSet ? "Set" : "Empty"}
          />
          <DetailField
            loading={briefing.isLoading}
            label="Characters"
            value={trimmedContent.length.toLocaleString()}
          />
          <DetailField
            loading={briefing.isLoading}
            label="Slug"
            value={record?.slug ?? "-"}
          />
          <DetailField
            loading={briefing.isLoading}
            label="Created"
            value={formatDate(record?.createdAt)}
          />
          <DetailField
            loading={briefing.isLoading}
            label="Updated"
            value={formatDate(record?.updatedAt)}
          />
        </div>
      </DetailPanel>
    </div>
  )
}
