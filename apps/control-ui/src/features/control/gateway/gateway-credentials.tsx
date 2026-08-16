import * as React from "react"
import { Check, Copy, KeyRound } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useIssuedGatewayCredentialStore } from "@/features/control/gateway/gateway-form-model"

export function GatewayCredentialField({
  copyLabel,
  description,
  label,
  value,
}: {
  copyLabel: string
  description?: string
  label: string
  value: string
}) {
  const inputId = React.useId()
  const [copied, setCopied] = React.useState(false)
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  async function copyValue() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const copyTarget = document.createElement("textarea")
        copyTarget.value = value
        copyTarget.setAttribute("readonly", "")
        copyTarget.style.position = "fixed"
        copyTarget.style.opacity = "0"
        document.body.append(copyTarget)
        copyTarget.select()
        const copied = document.execCommand("copy")
        copyTarget.remove()
        if (!copied) throw new Error("Clipboard copy failed")
      }
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      setCopied(true)
      copiedTimer.current = setTimeout(() => setCopied(false), 2_000)
      toast.success(`${copyLabel} copied`)
    } catch {
      toast.error(`Could not copy ${copyLabel.toLowerCase()}`)
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <label className="text-xs font-medium" htmlFor={inputId}>
        {label}
      </label>
      <div className="flex min-w-0 gap-2">
        <Input
          id={inputId}
          readOnly
          value={value}
          className="min-w-0 flex-1 font-mono"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copyValue()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            void copyValue()
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {description ? (
        <p className="text-xs/relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}

export function GatewayIssuedCredentialDialog() {
  const issuedCredential = useIssuedGatewayCredentialStore(
    (state) => state.issuedCredential
  )
  const clearIssuedCredential = useIssuedGatewayCredentialStore(
    (state) => state.clearIssuedCredential
  )
  const isSource = issuedCredential?.kind === "source"

  return (
    <Dialog
      open={Boolean(issuedCredential)}
      onOpenChange={(open) => {
        if (!open) clearIssuedCredential()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isSource
              ? "Gateway source credentials issued"
              : "Gateway device token issued"}
          </DialogTitle>
          <DialogDescription>
            {issuedCredential
              ? isSource
                ? `OAuth client credentials for source ${issuedCredential.sourceId}.`
                : `Bearer token for device ${issuedCredential.deviceId} on source ${issuedCredential.sourceId}.`
              : "Gateway credentials were issued."}
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <KeyRound className="size-4" />
          <AlertTitle>
            {isSource
              ? "Copy the client secret now"
              : "Copy the device token now"}
          </AlertTitle>
          <AlertDescription>
            {isSource
              ? "The client ID remains visible in Source focus. The client secret cannot be shown again."
              : "This is a device bearer token, not an OAuth client credential. It cannot be shown again."}
          </AlertDescription>
        </Alert>
        {issuedCredential?.kind === "source" ? (
          <div className="grid gap-4">
            <GatewayCredentialField
              label="OAuth client ID"
              copyLabel="Client ID"
              value={issuedCredential.clientId}
              description="Persistent, non-secret identifier. This is different from the source ID."
            />
            <GatewayCredentialField
              label="OAuth client secret"
              copyLabel="Client secret"
              value={issuedCredential.clientSecret}
              description="Shown only in this dialog. Rotating it invalidates the previous secret."
            />
          </div>
        ) : issuedCredential?.kind === "device" ? (
          <GatewayCredentialField
            label="Device bearer token"
            copyLabel="Device token"
            value={issuedCredential.token}
            description="Use only for the registered device endpoints and capabilities."
          />
        ) : null}
        <DialogFooter>
          <Button type="button" onClick={clearIssuedCredential}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
