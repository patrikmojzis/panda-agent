import * as React from "react"
import { Pencil, Plus, Power, Trash2 } from "lucide-react"

import { RowActionsMenu } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import {
  useAgentCredentials,
  useAgentMcpServers,
} from "@/features/control/api/queries"
import {
  controlApi,
  type McpHeaderValue,
  type McpServerPayload,
  type McpServerRow,
  type McpValueSource,
} from "@/lib/api"
import { useAuth } from "@/lib/auth"

const statusLabels: Record<McpServerRow["status"], string> = {
  disabled: "Disabled",
  ready: "Ready",
  missing_credentials: "Missing credentials",
  credential_store_unavailable: "Credential store unavailable",
  credential_unreadable: "Credential unreadable",
}

type Draft = {
  serverName: string
  transport: McpServerRow["transport"]
  enabled: boolean
  timeoutMs: string
  command: string
  args: string
  cwd: string
  env: string
  url: string
  headers: string
  bearerCredentialEnvKey: string
}

const emptyDraft: Draft = {
  serverName: "",
  transport: "stdio",
  enabled: true,
  timeoutMs: "30000",
  command: "",
  args: "",
  cwd: "",
  env: "{}",
  url: "",
  headers: "[]",
  bearerCredentialEnvKey: "",
}

function draftFor(row?: McpServerRow): Draft {
  if (!row) return emptyDraft
  if (row.transport === "stdio") {
    return {
      ...emptyDraft,
      serverName: row.serverName,
      transport: row.transport,
      enabled: row.enabled,
      timeoutMs: String(row.timeoutMs),
      command: row.command,
      args: row.args.join("\n"),
      cwd: row.cwd ?? "",
      env: JSON.stringify(row.env ?? {}, null, 2),
    }
  }
  return {
    ...emptyDraft,
    serverName: row.serverName,
    transport: row.transport,
    enabled: row.enabled,
    timeoutMs: String(row.timeoutMs),
    url: row.url,
    headers: JSON.stringify(row.headers ?? [], null, 2),
    bearerCredentialEnvKey: row.auth?.credentialEnvKey ?? "",
  }
}

function parseObject(
  value: string,
  label: string
): Record<string, McpValueSource> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return parsed as Record<string, McpValueSource>
}

function parseHeaders(value: string): McpHeaderValue[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error("Headers must be a JSON array.")
  return parsed as McpHeaderValue[]
}

function payloadFor(draft: Draft): McpServerPayload {
  const timeoutMs = Number(draft.timeoutMs)
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 120_000
  ) {
    throw new Error(
      "Timeout must be an integer from 1000 to 120000 milliseconds."
    )
  }
  if (draft.transport === "stdio") {
    if (!draft.command.trim())
      throw new Error("Command is required for stdio servers.")
    const env = parseObject(draft.env, "Environment")
    return {
      transport: "stdio",
      enabled: draft.enabled,
      command: draft.command.trim(),
      args: draft.args.split("\n").filter((value) => value.length > 0),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      timeoutMs,
    }
  }
  if (!draft.url.trim()) throw new Error("URL is required for HTTP servers.")
  const headers = parseHeaders(draft.headers)
  return {
    transport: draft.transport,
    enabled: draft.enabled,
    url: draft.url.trim(),
    ...(headers.length > 0 ? { headers } : {}),
    ...(draft.bearerCredentialEnvKey
      ? {
          auth: {
            type: "bearer",
            credentialEnvKey: draft.bearerCredentialEnvKey,
          },
        }
      : {}),
    timeoutMs,
  }
}

function withoutDto(
  row: McpServerRow,
  enabled = row.enabled
): McpServerPayload {
  if (row.transport === "stdio") {
    return {
      transport: row.transport,
      enabled,
      command: row.command,
      args: row.args,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.env ? { env: row.env } : {}),
      timeoutMs: row.timeoutMs,
    }
  }
  return {
    transport: row.transport,
    enabled,
    url: row.url,
    ...(row.headers ? { headers: row.headers } : {}),
    ...(row.auth ? { auth: row.auth } : {}),
    timeoutMs: row.timeoutMs,
  }
}

function McpServerDialog({
  agentKey,
  credentialKeys,
  row,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  agentKey: string
  credentialKeys: string[]
  row?: McpServerRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (serverName: string, payload: McpServerPayload) => Promise<unknown>
  pending: boolean
}) {
  const [draft, setDraft] = React.useState<Draft>(() => draftFor(row))
  const [error, setError] = React.useState<string | null>(null)
  const field = (name: keyof Draft, value: string | boolean) =>
    setDraft((current) => ({ ...current, [name]: value }))
  const changeTransport = (transport: Draft["transport"]) => {
    setDraft((current) => ({
      ...current,
      transport,
      command: "",
      args: "",
      cwd: "",
      env: "{}",
      url: "",
      headers: "[]",
      bearerCredentialEnvKey: "",
    }))
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      if (!draft.serverName.trim()) throw new Error("Server name is required.")
      await onSave(draft.serverName.trim(), payloadFor(draft))
      onOpenChange(false)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "MCP server save failed."
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {row ? "Edit MCP Server" : "Add MCP Server"}
          </DialogTitle>
          <DialogDescription>
            Configure a trusted server for {agentKey}. Credential fields store
            references only; resolved values are never shown.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="mcp-server-name">Server name</Label>
            <Input
              id="mcp-server-name"
              value={draft.serverName}
              disabled={Boolean(row)}
              required
              onChange={(event) => field("serverName", event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-transport">Transport</Label>
            <select
              id="mcp-transport"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={draft.transport}
              onChange={(event) =>
                changeTransport(event.target.value as Draft["transport"])
              }
            >
              <option value="stdio">stdio</option>
              <option value="streamable-http">Streamable HTTP</option>
              <option value="sse">Legacy SSE</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="mcp-enabled"
              checked={draft.enabled}
              onCheckedChange={(checked) => field("enabled", checked === true)}
            />
            <Label htmlFor="mcp-enabled">Enabled</Label>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-timeout">
              Absolute command timeout (milliseconds)
            </Label>
            <Input
              id="mcp-timeout"
              inputMode="numeric"
              value={draft.timeoutMs}
              onChange={(event) => field("timeoutMs", event.target.value)}
              required
            />
          </div>
          {draft.transport === "stdio" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  value={draft.command}
                  onChange={(event) => field("command", event.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-args">Arguments (one per line)</Label>
                <Textarea
                  id="mcp-args"
                  value={draft.args}
                  onChange={(event) => field("args", event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-cwd">Working directory</Label>
                <Input
                  id="mcp-cwd"
                  value={draft.cwd}
                  onChange={(event) => field("cwd", event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-env">Environment JSON</Label>
                <Textarea
                  id="mcp-env"
                  className="min-h-32 font-mono text-xs"
                  value={draft.env}
                  onChange={(event) => field("env", event.target.value)}
                  aria-describedby="mcp-env-help"
                />
                <p id="mcp-env-help" className="text-xs text-muted-foreground">
                  Use{" "}
                  {`{"KEY":{"value":"literal"},"TOKEN":{"credentialEnvKey":"TOKEN"}}`}
                  .
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="mcp-url">Endpoint URL</Label>
                <Input
                  id="mcp-url"
                  type="url"
                  value={draft.url}
                  onChange={(event) => field("url", event.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-bearer">Bearer credential reference</Label>
                <Input
                  id="mcp-bearer"
                  list="mcp-credential-keys"
                  value={draft.bearerCredentialEnvKey}
                  onChange={(event) =>
                    field("bearerCredentialEnvKey", event.target.value)
                  }
                />
                <datalist id="mcp-credential-keys">
                  {credentialKeys.map((key) => (
                    <option key={key} value={key} />
                  ))}
                </datalist>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-headers">Headers JSON</Label>
                <Textarea
                  id="mcp-headers"
                  className="min-h-32 font-mono text-xs"
                  value={draft.headers}
                  onChange={(event) => field("headers", event.target.value)}
                  aria-describedby="mcp-headers-help"
                />
                <p
                  id="mcp-headers-help"
                  className="text-xs text-muted-foreground"
                >
                  Each header uses either value or credentialEnvKey. Redirects
                  are always rejected.
                </p>
              </div>
            </>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function McpPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const servers = useAgentMcpServers(agentKey)
  const credentials = useAgentCredentials(agentKey, { per_page: 100 })
  const [editing, setEditing] = React.useState<McpServerRow | undefined>()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const invalidate = controlKeys.agents.detail(agentKey)
  const save = useToastMutation({
    mutationFn: ({
      serverName,
      payload,
    }: {
      serverName: string
      payload: McpServerPayload
    }) =>
      controlApi.putMcpServer(agentKey, serverName, payload, auth.csrfToken),
    success: "MCP server saved",
    invalidate,
  })
  const toggle = useToastMutation({
    mutationFn: (row: McpServerRow) =>
      controlApi.putMcpServer(
        agentKey,
        row.serverName,
        withoutDto(row, !row.enabled),
        auth.csrfToken
      ),
    success: "MCP server status updated",
    invalidate,
  })
  const remove = useToastMutation({
    mutationFn: (row: McpServerRow) =>
      controlApi.deleteMcpServer(agentKey, row.serverName, auth.csrfToken),
    success: "MCP server deleted",
    invalidate,
  })
  const openCreate = () => {
    setEditing(undefined)
    setDialogOpen(true)
  }
  const openEdit = (row: McpServerRow) => {
    setEditing(row)
    setDialogOpen(true)
  }

  if (servers.isLoading)
    return <p className="text-sm text-muted-foreground">Loading MCP servers…</p>
  if (servers.error) {
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-destructive">{servers.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void servers.refetch()}
        >
          Retry
        </Button>
      </div>
    )
  }
  const rows = servers.data?.servers ?? []
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">MCP servers</h2>
          <p className="text-sm text-muted-foreground">
            Agent-scoped registry. Production runtime reads this database config
            only.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          Add server
        </Button>
      </div>
      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No MCP servers</CardTitle>
            <CardDescription>
              Add stdio, Streamable HTTP, or legacy SSE servers for this agent.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        rows.map((row) => (
          <Card key={row.serverName}>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="text-base">{row.serverName}</CardTitle>
                <CardDescription>
                  {row.transport} · {row.timeoutMs / 1000}s deadline
                </CardDescription>
              </div>
              <RowActionsMenu
                triggerLabel={`Open actions for MCP server ${row.serverName}`}
                actions={[
                  {
                    label: "Edit",
                    icon: <Pencil className="size-4" />,
                    onSelect: () => openEdit(row),
                  },
                  {
                    label: row.enabled ? "Disable" : "Enable",
                    icon: <Power className="size-4" />,
                    pending: toggle.isPending,
                    confirm: {
                      title: `${row.enabled ? "Disable" : "Enable"} MCP server`,
                      description: `${row.enabled ? "Disable" : "Enable"} ${row.serverName}?`,
                      confirmLabel: row.enabled
                        ? "Disable server"
                        : "Enable server",
                      entityLabel: "MCP server",
                      itemLabel: row.serverName,
                    },
                    onSelect: () => toggle.mutateAsync(row),
                  },
                  {
                    label: "Delete",
                    icon: <Trash2 className="size-4" />,
                    destructive: true,
                    pending: remove.isPending,
                    confirm: {
                      title: "Delete MCP server",
                      description: `Delete ${row.serverName} from this agent registry?`,
                      confirmLabel: "Delete server",
                      entityLabel: "MCP server",
                      itemLabel: row.serverName,
                    },
                    onSelect: () => remove.mutateAsync(row),
                  },
                ]}
              />
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={row.status === "ready" ? "secondary" : "outline"}>
                {statusLabels[row.status]}
              </Badge>
              <Badge variant="outline">
                {row.enabled ? "enabled" : "disabled"}
              </Badge>
              {row.credentialEnvKeys.map((key) => (
                <Badge key={key} variant="outline">
                  credential: {key}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ))
      )}
      {dialogOpen ? (
        <McpServerDialog
          key={editing?.serverName ?? "new"}
          agentKey={agentKey}
          credentialKeys={(credentials.data?.data ?? []).map(
            (row) => row.envKey
          )}
          row={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          pending={save.isPending}
          onSave={(serverName, payload) =>
            save.mutateAsync({ serverName, payload })
          }
        />
      ) : null}
    </div>
  )
}
