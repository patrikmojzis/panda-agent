import * as React from "react"
import { Minimize2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

export function CompactSessionDialog({
  agentKey,
  sessionId,
  sessionLabel,
  open,
  onOpenChange,
}: {
  agentKey: string
  sessionId: string
  sessionLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const auth = useAuth()
  const [instructions, setInstructions] = React.useState("")
  const compact = useToastMutation({
    mutationFn: (value: string) =>
      controlApi.compactSession(agentKey, sessionId, value, auth.csrfToken),
    success: "Compaction finished",
    invalidate: controlKeys.agents.detail(agentKey),
  })

  function handleOpenChange(nextOpen: boolean) {
    if (compact.isPending) return
    if (!nextOpen) setInstructions("")
    onOpenChange(nextOpen)
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await compact.mutateAsync(instructions)
      handleOpenChange(false)
    } catch {
      // The mutation hook owns the error toast. Keep the dialog open for retry.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Compact session context</DialogTitle>
            <DialogDescription>
              Summarizes older context on the current thread and preserves
              recent turns. This makes a model call and can take a minute.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <div className="text-xs text-muted-foreground uppercase">
              Session
            </div>
            <div className="text-sm font-medium break-words">
              {sessionLabel}
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`compact-instructions-${sessionId}`}>
              Additional instructions (optional)
            </Label>
            <Textarea
              id={`compact-instructions-${sessionId}`}
              value={instructions}
              maxLength={20_000}
              disabled={compact.isPending}
              placeholder="For example: preserve the incident timeline and pending decisions."
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={compact.isPending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={compact.isPending}>
              {compact.isPending ? (
                <Spinner className="size-3.5" />
              ) : (
                <Minimize2 className="size-3.5" />
              )}
              Compact context
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
