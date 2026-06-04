import * as React from "react"
import type { AppFieldExtendedReactFormApi } from "@tanstack/react-form"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"

// TanStack's app-form extension type exposes component maps through `any`.
// Keeping the escape here avoids leaking that complexity into every form sheet caller.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControlFormApi = AppFieldExtendedReactFormApi<any, any, any, any, any, any, any, any, any, any, any, any, any, any>
type FormUiState = [canSubmit: boolean, isSubmitting: boolean, isDirty: boolean]
type FormSheetDialog = "submit" | "discard" | null

export function FormSheet({
  children,
  confirmSubmit,
  description,
  form,
  isOpen,
  resetValues,
  setIsOpen,
  submitDisabled = false,
  submitLabel = "Save",
  title,
}: {
  children: React.ReactNode
  confirmSubmit?: {
    title: string
    description: string
    confirmLabel?: string
  }
  description?: string
  form: ControlFormApi
  isOpen: boolean
  resetValues?: Record<string, unknown>
  setIsOpen: (isOpen: boolean) => void
  submitDisabled?: boolean
  submitLabel?: string
  title: string
}) {
  const [dialog, setDialog] = React.useState<FormSheetDialog>(null)
  const [confirmSubmitPending, setConfirmSubmitPending] = React.useState(false)
  const formUiState = React.useRef({ isDirty: false, isSubmitting: false })

  React.useEffect(() => {
    if (isOpen) form.reset(resetValues)
  }, [form, isOpen, resetValues])

  function closeSheet() {
    setDialog(null)
    setIsOpen(false)
  }

  function requestClose() {
    if (formUiState.current.isSubmitting || confirmSubmitPending) return
    if (formUiState.current.isDirty) {
      setDialog("discard")
      return
    }
    closeSheet()
  }

  async function submitConfirmed(event: React.MouseEvent) {
    event.preventDefault()
    setConfirmSubmitPending(true)
    try {
      await form.handleSubmit()
      setDialog(null)
    } finally {
      setConfirmSubmitPending(false)
    }
  }

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (open) {
          setDialog(null)
          setIsOpen(true)
          return
        }
        requestClose()
      }}
    >
      <SheetContent className="min-w-0 gap-0 overflow-x-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-md" showCloseButton={false}>
        <form.AppForm>
          <form
            noValidate
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void form.handleSubmit()
            }}
          >
            <SheetHeader className="relative shrink-0 border-b pr-12">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription className={description ? undefined : "sr-only"}>{description ?? `${title} form`}</SheetDescription>
              <form.Subscribe selector={(state: { isSubmitting: boolean }): boolean => state.isSubmitting}>
                {(isSubmitting: boolean) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-3 top-3"
                    disabled={isSubmitting}
                    aria-label="Close form"
                    onClick={requestClose}
                  >
                    <XIcon className="size-4" />
                  </Button>
                )}
              </form.Subscribe>
            </SheetHeader>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4">
              <div className="grid min-w-0 gap-4">{children}</div>
            </div>
            <form.Subscribe selector={(state: { canSubmit: boolean; isSubmitting: boolean; isDirty: boolean }): FormUiState => [state.canSubmit, state.isSubmitting, state.isDirty]}>
              {(submitState: FormUiState) => {
                const [canSubmit, isSubmitting, isDirty] = submitState
                formUiState.current = { isDirty, isSubmitting }
                const submitBusy = isSubmitting || confirmSubmitPending
                return (
                  <SheetFooter className="mt-0 flex-row shrink-0 border-t">
                    <Button type="button" variant="outline" className="flex-1" disabled={submitBusy} onClick={requestClose}>
                      Cancel
                    </Button>
                    {confirmSubmit ? (
                      <AlertDialog
                        open={dialog === "submit"}
                        onOpenChange={(open) => {
                          if (!open && submitBusy) return
                          setDialog(open ? "submit" : null)
                        }}
                      >
                        <Button type="button" className="flex-1" disabled={submitDisabled || !canSubmit || submitBusy} onClick={() => setDialog("submit")}>
                          {submitBusy ? <Spinner className="size-3.5" /> : null}
                          {submitLabel}
                        </Button>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{confirmSubmit.title}</AlertDialogTitle>
                            <AlertDialogDescription>{confirmSubmit.description}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={submitBusy}>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              disabled={submitBusy}
                              onClick={submitConfirmed}
                            >
                              {submitBusy ? <Spinner className="size-3.5" /> : null}
                              {confirmSubmit.confirmLabel ?? submitLabel}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <Button type="submit" className="flex-1" disabled={submitDisabled || !canSubmit || submitBusy}>
                        {submitBusy ? <Spinner className="size-3.5" /> : null}
                        {submitLabel}
                      </Button>
                    )}
                  </SheetFooter>
                )
              }}
            </form.Subscribe>
          </form>
        </form.AppForm>
      </SheetContent>
      <AlertDialog open={dialog === "discard"} onOpenChange={(open) => setDialog(open ? "discard" : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>This form has unsaved changes. Closing it will discard them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row">
            <AlertDialogCancel variant="default">Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={closeSheet}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
