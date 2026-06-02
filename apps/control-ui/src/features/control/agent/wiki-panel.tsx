import * as React from "react"
import { BookOpen, Pencil, Trash2 } from "lucide-react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useAgentWikiBinding } from "@/features/control/api/queries"
import {
  DetailField,
  DetailPanel,
  DetailsGrid,
  TableError,
} from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/control-display"
import { wikiBindingToFormValues } from "@/features/control/forms/form-values"
import { useInvalidateAgent, agentCacheKey } from "@/features/control/forms/form-sheet-shared"
import { useWikiBindingSheet } from "@/features/control/forms/use-control-form-sheets"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

export function WikiPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const wiki = useAgentWikiBinding(agentKey)
  const binding = wiki.data?.binding ?? null
  const bindingSheet = useWikiBindingSheet()
  const invalidate = useInvalidateAgent(agentKey)
  const [confirmClear, setConfirmClear] = React.useState(false)
  const clearMutation = useMutation({
    mutationFn: () => controlApi.clearWikiBinding(agentKey, auth.csrfToken),
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Wiki binding clear failed")
    },
    onSuccess: async () => {
      toast.success("Wiki binding cleared")
      setConfirmClear(false)
      await invalidate(agentCacheKey(agentKey))
    },
  })

  function openSheet() {
    bindingSheet.setOpen(true, {
      context: { agentKey },
      ...(binding
        ? {
            defaultData: wikiBindingToFormValues(binding),
            entity: binding,
          }
        : {}),
    })
  }

  if (wiki.error && !binding) {
    return <TableError error={wiki.error} />
  }

  return (
    <>
      <DetailPanel
        title="Wiki.js binding"
        action={
          <Button size="sm" onClick={openSheet}>
            {binding ? <Pencil className="size-4" /> : <BookOpen className="size-4" />}
            {binding ? "Update binding" : "Store binding"}
          </Button>
        }
      >
        <div className="grid gap-4">
          <div className="rounded-none border bg-muted/20 p-3 text-sm text-muted-foreground">
            Wiki bindings connect one visible agent to a Wiki.js group and namespace. The API token is write-only; updating this binding requires pasting a fresh token.
          </div>
          <DetailsGrid placement="main">
            <DetailField
              loading={wiki.isLoading}
              label="Status"
              value={
                binding ? (
                  <Badge variant="outline">Configured</Badge>
                ) : (
                  <Badge variant="secondary">Missing</Badge>
                )
              }
            />
            <DetailField
              loading={wiki.isLoading}
              label="Group id"
              value={binding?.wikiGroupId}
            />
            <DetailField
              loading={wiki.isLoading}
              label="Namespace"
              value={binding?.namespacePath ? <code>{binding.namespacePath}</code> : undefined}
            />
            <DetailField
              loading={wiki.isLoading}
              label="Token"
              value={binding ? <Badge variant="secondary">write-only</Badge> : undefined}
            />
            <DetailField
              loading={wiki.isLoading}
              label="Updated"
              value={formatDate(binding?.updatedAt)}
            />
          </DetailsGrid>
          {binding ? (
            <div className="flex justify-end">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="size-4" />
                Clear binding
              </Button>
            </div>
          ) : null}
        </div>
      </DetailPanel>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Wiki binding?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the stored Wiki.js API token and namespace binding for {agentKey}. The token cannot be recovered from Control.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={clearMutation.isPending}
              onClick={(event) => {
                event.preventDefault()
                void clearMutation.mutateAsync()
              }}
            >
              {clearMutation.isPending ? <Spinner className="size-3.5" /> : null}
              Clear binding
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
