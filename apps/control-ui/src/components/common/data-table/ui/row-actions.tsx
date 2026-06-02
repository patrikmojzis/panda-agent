import * as React from "react"
import { MoreHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export type RowAction = {
  label: string
  icon?: React.ReactNode
  destructive?: boolean
  disabled?: boolean
  pending?: boolean
  onSelect: () => void | Promise<unknown>
  confirm?: {
    title: string
    description: string
    confirmLabel?: string
    entityLabel?: string
    itemLabel?: string
  }
}

export default function RowActionsMenu({
  actions,
  label = "Actions",
  triggerLabel,
}: {
  actions: RowAction[]
  label?: string
  triggerLabel?: string
}) {
  const [confirming, setConfirming] = React.useState<RowAction | null>(null)
  const [running, setRunning] = React.useState<string | null>(null)
  const regularActions = actions.filter((action) => !action.destructive)
  const destructiveActions = actions.filter((action) => action.destructive)
  const accessibleLabel =
    triggerLabel ??
    (label === "Actions" ? "Open row actions" : `Open ${label} actions`)
  const confirmingPending = Boolean(confirming?.pending || running === confirming?.label)

  async function runAction(action: RowAction, closeConfirm = false) {
    const result = action.onSelect()
    if (!isPromise(result)) {
      if (closeConfirm) setConfirming(null)
      return
    }

    setRunning(action.label)
    try {
      await result
      if (closeConfirm) setConfirming(null)
    } catch {
      // The mutation hook owns the user-facing error toast.
    } finally {
      setRunning(null)
    }
  }

  function runConfirmedAction(event: React.MouseEvent) {
    event.preventDefault()
    if (!confirming) return
    void runAction(confirming, true)
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={accessibleLabel}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuGroup>
            <ActionItems
              actions={regularActions}
              running={running}
              runAction={runAction}
              setConfirming={setConfirming}
            />
          </DropdownMenuGroup>
          {regularActions.length > 0 && destructiveActions.length > 0 ? <DropdownMenuSeparator /> : null}
          {destructiveActions.length > 0 ? (
            <DropdownMenuGroup>
              <ActionItems
                actions={destructiveActions}
                running={running}
                runAction={runAction}
                setConfirming={setConfirming}
              />
            </DropdownMenuGroup>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          if (!open && !confirmingPending) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.confirm?.title ?? "Confirm action"}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.confirm?.description ?? "This action cannot be undone."}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirming?.confirm?.itemLabel ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              {confirming.confirm.entityLabel ? (
                <div className="text-xs uppercase text-muted-foreground">
                  {confirming.confirm.entityLabel}
                </div>
              ) : null}
              <div className="break-words text-sm font-medium">
                {confirming.confirm.itemLabel}
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmingPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmingPending}
              variant={confirming?.destructive ? "destructive" : "default"}
              onClick={runConfirmedAction}
            >
              {confirmingPending ? <Spinner className="size-3.5" /> : null}
              {confirming?.confirm?.confirmLabel ?? confirming?.label ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ActionItems({
  actions,
  running,
  runAction,
  setConfirming,
}: {
  actions: RowAction[]
  running: string | null
  runAction: (action: RowAction) => void | Promise<unknown>
  setConfirming: (action: RowAction) => void
}) {
  return actions.map((action, index) => (
    <DropdownMenuItem
      key={`${action.label}:${index}`}
      variant={action.destructive ? "destructive" : "default"}
      disabled={action.disabled || action.pending || running === action.label}
      onSelect={(event) => {
        if (action.confirm) {
          event.preventDefault()
          setConfirming(action)
          return
        }
        void runAction(action)
      }}
    >
      {action.pending || running === action.label ? <Spinner className="size-3.5" /> : null}
      {action.icon}
      {action.label}
    </DropdownMenuItem>
  ))
}

function isPromise(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof (value as Promise<unknown>).then === "function")
}
