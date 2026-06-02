import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  entityLabel,
  itemLabel,
  children,
  onConfirm,
  disabled = false,
  variant = "outline",
}: {
  title: string
  description: string
  confirmLabel?: string
  entityLabel?: string
  itemLabel?: string
  children: React.ReactNode
  onConfirm: () => void | Promise<unknown>
  disabled?: boolean
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  const [open, setOpen] = React.useState(false)
  const [isConfirming, setIsConfirming] = React.useState(false)

  async function handleConfirm(event: React.MouseEvent) {
    const result = onConfirm()
    if (!isPromise(result)) {
      setOpen(false)
      return
    }

    event.preventDefault()
    setIsConfirming(true)
    try {
      await result
      setOpen(false)
    } catch {
      // Mutation hooks own user-facing error toasts. Keep dialog open for retry.
    } finally {
      setIsConfirming(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isConfirming) setOpen(nextOpen)
      }}
    >
      <AlertDialogTrigger asChild>
        <Button disabled={disabled} variant={variant} size="sm">
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {itemLabel ? (
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            {entityLabel ? (
              <div className="text-xs uppercase text-muted-foreground">
                {entityLabel}
              </div>
            ) : null}
            <div className="break-words text-sm font-medium">{itemLabel}</div>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isConfirming}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isConfirming}
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={handleConfirm}
          >
            {isConfirming ? <Spinner className="size-3.5" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function ConfirmSwitch({
  checked,
  disabled,
  label,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  title: (nextChecked: boolean) => string
  description: (nextChecked: boolean) => string
  confirmLabel: (nextChecked: boolean) => string
  onConfirm: (nextChecked: boolean) => void | Promise<unknown>
}) {
  const [nextChecked, setNextChecked] = React.useState<boolean | null>(null)
  const [isConfirming, setIsConfirming] = React.useState(false)
  const isOpen = nextChecked !== null
  const nextValue = nextChecked ?? checked

  async function handleConfirm(event: React.MouseEvent) {
    if (nextChecked === null) return
    const result = onConfirm(nextChecked)
    if (!isPromise(result)) {
      setNextChecked(null)
      return
    }

    event.preventDefault()
    setIsConfirming(true)
    try {
      await result
      setNextChecked(null)
    } catch {
      // Mutation hooks own user-facing error toasts. Keep dialog open for retry.
    } finally {
      setIsConfirming(false)
    }
  }

  return (
    <>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={(value) => setNextChecked(value)}
      />
      <AlertDialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open && !isConfirming) setNextChecked(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title(nextValue)}</AlertDialogTitle>
            <AlertDialogDescription>
              {description(nextValue)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isConfirming}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isConfirming}
              variant={nextValue ? "default" : "destructive"}
              onClick={handleConfirm}
            >
              {isConfirming ? <Spinner className="size-3.5" /> : null}
              {confirmLabel(nextValue)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function isPromise(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof (value as Promise<unknown>).then === "function")
}
