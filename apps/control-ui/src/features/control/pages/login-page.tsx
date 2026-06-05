import * as React from "react"
import { Navigate } from "react-router-dom"
import { KeyRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ApiError } from "@/lib/api"
import { useAuth } from "@/lib/auth"

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      <span>{label}</span>
      {children}
    </label>
  )
}

function getDevLoginErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return "Dev login is not allowed in this environment."
    if (error.status === 404)
      return "Dev login is not available in this environment."
    if (error.status === 400) return error.message
    return "The dev login request failed."
  }
  return "Network error. Please try again."
}

function LoginPage() {
  const auth = useAuth()
  const [token, setToken] = React.useState("")
  const [remember, setRemember] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [devIdentity, setDevIdentity] = React.useState(
    import.meta.env.VITE_CONTROL_DEV_LOGIN_IDENTITY ?? ""
  )
  const [devRole, setDevRole] = React.useState<"admin" | "scoped">(
    import.meta.env.VITE_CONTROL_DEV_LOGIN_ROLE === "scoped"
      ? "scoped"
      : "admin"
  )
  const [devAgentKey, setDevAgentKey] = React.useState(
    import.meta.env.VITE_CONTROL_DEV_LOGIN_AGENT_KEY ?? ""
  )
  const [devError, setDevError] = React.useState<string | null>(null)
  const [devSubmitting, setDevSubmitting] = React.useState(false)

  if (auth.session) return <Navigate to="/" replace />

  return (
    <div className="grid min-h-svh place-items-center p-4">
      <div className="grid w-full max-w-sm gap-3">
        <form
          className="grid gap-4 border p-4"
          onSubmit={async (event) => {
            event.preventDefault()
            setError(null)
            try {
              await auth.login({ token, remember })
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Login failed")
            }
          }}
        >
          <div>
            <h1 className="text-lg font-semibold">Control Login</h1>
            <p className="text-xs text-muted-foreground">
              Paste the one-time operator token.
            </p>
          </div>
          <Input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
          />
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
              aria-label="Remember this device"
            />
            <span>
              Remember this browser for 30 days. Do not use this on shared
              machines.
            </span>
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button type="submit">
            <KeyRound className="size-4" />
            Sign in
          </Button>
        </form>

        {import.meta.env.DEV ? (
          <form
            className="grid gap-4 border bg-muted/20 p-4"
            onSubmit={async (event) => {
              event.preventDefault()
              setDevError(null)
              setDevSubmitting(true)
              try {
                await auth.devLogin({
                  identity: devIdentity.trim() || undefined,
                  role: devRole,
                  agentKey:
                    devRole === "scoped"
                      ? devAgentKey.trim() || undefined
                      : undefined,
                })
              } catch (cause) {
                setDevError(getDevLoginErrorMessage(cause))
              } finally {
                setDevSubmitting(false)
              }
            }}
          >
            <div>
              <h2 className="text-sm font-semibold">Dev Sign In</h2>
            </div>
            <Field label="Identity">
              <Input
                value={devIdentity}
                onChange={(event) => setDevIdentity(event.target.value)}
                placeholder="handle or id"
              />
            </Field>
            <Field label="Role">
              <Select
                value={devRole}
                onValueChange={(value) =>
                  setDevRole(value === "scoped" ? "scoped" : "admin")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="scoped">Scoped</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {devRole === "scoped" ? (
              <Field label="Agent">
                <Input
                  value={devAgentKey}
                  onChange={(event) => setDevAgentKey(event.target.value)}
                  placeholder="agent key"
                />
              </Field>
            ) : null}
            {devError ? (
              <p className="text-xs text-destructive">{devError}</p>
            ) : null}
            <Button type="submit" variant="secondary" disabled={devSubmitting}>
              <KeyRound className="size-4" />
              {devSubmitting ? "Signing in" : "Dev sign in"}
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  )
}

export { LoginPage }
export default LoginPage
